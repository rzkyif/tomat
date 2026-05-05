/**
 * The live LLM-stream layer. Owns the per-turn streaming flags, the
 * coalescing flush timer, the TTS feed cursor, and the reasoning-bubble
 * cursor. Reads / writes `messagesState.messages` to mutate the assistant
 * bubble in place; defers persistence (save scheduling, flushSave) to
 * persistenceState; lazily imports tts.svelte to feed audio.
 */

import { makeMessageId, type LLMErrorType, type PendingToolCall } from "$lib/shared/types";
import { stripEmojisForTTS, stripMarkdownForTTS } from "$lib/shared/text";
import { interruptCurrentStream } from "$lib/shared/interrupt";
import { messagesState } from "./messages.svelte";
import { persistenceState } from "./persistence.svelte";
import { settingsState } from "./settings.svelte";

/** Coalesce streaming tokens before pushing into reactive state. At ~30 ms we
 *  stay under one frame at 30 fps and avoid re-parsing the full markdown blob
 *  per token (which would dominate at high token rates). */
const STREAM_FLUSH_MS = 30;

type InterruptListener = () => void | Promise<void>;

class StreamingState {
  isActive = $state(false);
  firstChunkReceived = $state(false);
  /** Id of the assistant message currently receiving stream chunks. Normally
   *  the newest message (freshly pushed by `start`), but for `beginReprocess`
   *  it points at an existing message mid-array so the regenerated content
   *  lands in place without disturbing newer turns. */
  messageId = $state<string | null>(null);
  /** Id of the `role: "reasoning"` message currently receiving reasoning
   *  chunks. Lazily created on the first reasoning delta and cleared when the
   *  first content chunk arrives (or the stream finishes / errors). Lives in
   *  its own bubble, separate from the paired assistant content message. */
  reasoningId = $state<string | null>(null);
  /** True whenever there is something the user could interrupt: either an
   *  in-flight LLM stream or any active tool call. Composed with the
   *  tool-call check on messagesState; UI exposes a single "stop" affordance
   *  that should react to either. */
  hasActiveWork = $derived(this.isActive || messagesState.hasActiveToolCall);

  private streamBuffer = "";
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsCursor = 0;
  /** Wall-clock start of the current assistant turn's reasoning trace.
   *  Set on the first reasoning delta, cleared when the duration is written
   *  onto the message (on first content chunk or on finish). */
  private reasoningStartTime: number | null = null;
  /** Toolkit cancellation handler is registered here at module scope so the
   *  static import graph stays one-way (toolkits -> streaming). Awaited inside
   *  `interruptStreaming` so callers get deterministic ordering: by the time
   *  it resolves, every cancel frame has been queued. */
  private interruptListeners: InterruptListener[] = [];

  onInterrupt(fn: InterruptListener): () => void {
    this.interruptListeners.push(fn);
    return () => {
      const idx = this.interruptListeners.indexOf(fn);
      if (idx >= 0) this.interruptListeners.splice(idx, 1);
    };
  }

  /** Stop any in-flight or queued TTS playback. Lazy-imports tts.svelte so
   *  the audio bundle stays out of the eager import graph. Used at session
   *  boundaries (sessionsState) and around message mutations (messagesState)
   *  in addition to streaming-internal end states. */
  resetTTSPlayback(): void {
    void import("./tts.svelte").then(({ ttsState }) => ttsState.reset());
  }

  /** Resolve the array index of the message currently being streamed into.
   *  Returns -1 when there is no active stream or the target has been spliced
   *  away (e.g. user deleted the streaming message). */
  private getActiveIndex(): number {
    if (this.messageId === null) return -1;
    return messagesState.messages.findIndex((m) => m.id === this.messageId);
  }

  start(modelUsed: "default" | "secondary" = "default") {
    this.isActive = true;
    this.firstChunkReceived = false;
    this.reasoningStartTime = null;
    this.reasoningId = null;
    this.ttsCursor = 0;
    const assistantId = makeMessageId();
    this.messageId = assistantId;
    void import("./tts.svelte").then(({ ttsState }) => ttsState.startStream(assistantId));
    messagesState.addMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      modelUsed,
    });
  }

  /** Set up for reprocessing an existing assistant message in place. Unlike
   *  `start`, does not push a new message - streaming will write back into
   *  the existing slot so newer conversation turns stay untouched. */
  beginReprocess(targetId: string): boolean {
    const idx = messagesState.messages.findIndex((m) => m.id === targetId);
    if (idx < 0) return false;
    this.isActive = true;
    this.firstChunkReceived = false;
    this.reasoningStartTime = null;
    this.reasoningId = null;
    this.ttsCursor = 0;
    this.messageId = targetId;
    // Drop any prior reasoning bubble paired to this assistant turn. A new
    // one will be lazily created if reasoning fires again on the regenerated
    // run.
    const reasoningIdx = messagesState.messages.findIndex(
      (m) => m.role === "reasoning" && m.pairedAssistantId === targetId,
    );
    if (reasoningIdx >= 0) {
      messagesState.messages.splice(reasoningIdx, 1);
    }
    // Clear existing content so the regenerated output replaces, not appends.
    // Preserve role + id + modelUsed. (Re-find the index in case the prior
    // reasoning splice shifted it.)
    const refreshedIdx = messagesState.messages.findIndex((m) => m.id === targetId);
    if (refreshedIdx < 0) return false;
    const existing = messagesState.messages[refreshedIdx];
    messagesState.messages[refreshedIdx] = {
      ...existing,
      role: "assistant",
      content: "",
    };
    // Reset the paired tool_filter bubble so the spinner shows during the
    // re-run instead of stale phase-1/phase-2 results.
    const pairedUser = messagesState.messages
      .slice(refreshedIdx + 1)
      .find((m) => m.role === "user");
    if (pairedUser?.id && settingsState.currentSettings["tools.enabled"]) {
      messagesState.upsertToolFilterMessage(pairedUser.id, {
        status: "filtering",
        phase1: null,
        phase2: null,
        alwaysAvailable: null,
      });
    }
    void import("./tts.svelte").then(({ ttsState }) => ttsState.startStream(targetId));
    return true;
  }

  appendContent(content: string) {
    const idx = this.getActiveIndex();
    if (idx < 0) return;
    if (!this.firstChunkReceived) {
      this.firstChunkReceived = true;
      this.finalizeReasoningDuration();
      messagesState.messages[idx] = { ...messagesState.messages[idx], content: "" };
      this.streamBuffer = "";
    }
    this.streamBuffer += content;
    if (!this.streamFlushTimer) {
      this.streamFlushTimer = setTimeout(() => this.flushStreamBuffer(), STREAM_FLUSH_MS);
    }
  }

  /** Accumulate a reasoning-trace delta. Lazily creates a `role: "reasoning"`
   *  bubble on the first delta of a turn, paired to the currently-streaming
   *  assistant message. Written directly (no coalesce) since reasoning token
   *  rates are lower than content rates in practice. */
  appendReasoning(delta: string) {
    if (!delta) return;
    if (this.messageId === null) return;
    if (this.firstChunkReceived) return;

    if (this.reasoningId === null) {
      const contentIdx = messagesState.messages.findIndex((m) => m.id === this.messageId);
      if (contentIdx < 0) return;
      const contentMsg = messagesState.messages[contentIdx];
      const reasoningId = makeMessageId();
      this.reasoningId = reasoningId;
      this.reasoningStartTime = Date.now();
      // Insert immediately after the assistant content message in the
      // newest-first array, which places the reasoning bubble older (higher
      // index) than its paired content, matching the chronological order in
      // which the model emits them.
      messagesState.messages.splice(contentIdx + 1, 0, {
        id: reasoningId,
        role: "reasoning",
        content: delta,
        modelUsed: contentMsg.modelUsed,
        pairedAssistantId: contentMsg.id,
      });
      persistenceState.scheduleSave();
      return;
    }

    const idx = messagesState.messages.findIndex((m) => m.id === this.reasoningId);
    if (idx < 0) return;
    const cur = (messagesState.messages[idx].content as string) || "";
    messagesState.messages[idx] = { ...messagesState.messages[idx], content: cur + delta };
  }

  /** Freeze the elapsed reasoning time onto the streaming reasoning bubble so
   *  historic loads can render "Thought for Xs" without live tracking, then
   *  clear the streaming-reasoning slot so subsequent state transitions stop
   *  treating it as live. No-op if no reasoning bubble is currently open. */
  private finalizeReasoningDuration() {
    if (this.reasoningId === null) {
      this.reasoningStartTime = null;
      return;
    }
    const idx = messagesState.messages.findIndex((m) => m.id === this.reasoningId);
    if (idx < 0) {
      this.reasoningId = null;
      this.reasoningStartTime = null;
      return;
    }
    if (this.reasoningStartTime !== null) {
      const duration = Date.now() - this.reasoningStartTime;
      messagesState.messages[idx] = {
        ...messagesState.messages[idx],
        reasoningDurationMs: duration,
      };
    }
    this.reasoningId = null;
    this.reasoningStartTime = null;
  }

  private flushStreamBuffer() {
    this.streamFlushTimer = null;
    if (!this.streamBuffer) return;
    const idx = this.getActiveIndex();
    if (idx < 0) {
      this.streamBuffer = "";
      return;
    }
    const cur = (messagesState.messages[idx]?.content as string) || "";
    const next = cur + this.streamBuffer;
    messagesState.messages[idx] = {
      ...messagesState.messages[idx],
      content: next,
    };
    this.streamBuffer = "";
    void this.feedTTS(next, /* final */ false);
  }

  private async feedTTS(fullText: string, final: boolean): Promise<void> {
    const settings = settingsState.currentSettings;
    if (!settings["tts.enabled"]) return;
    const { ttsState } = await import("./tts.svelte");
    if (!ttsState.loaded) return;

    // Don't interleave with a replay that's voicing a different message.
    const activeId = this.messageId;
    if (
      ttsState.currentMessageId !== null &&
      activeId !== null &&
      ttsState.currentMessageId !== activeId
    ) {
      return;
    }

    // Strip markdown BEFORE segmenting - Intl.Segmenter isn't markdown-aware
    // and otherwise gets confused by URLs, code fences, table pipes, etc.
    // ttsCursor indexes into the stripped text, not the raw stream.
    let stripped = stripMarkdownForTTS(fullText);
    if (!settingsState.currentSettings["tts.spellOutEmojis"]) {
      stripped = stripEmojisForTTS(stripped);
    }
    const remaining = stripped.slice(this.ttsCursor);
    if (!remaining) {
      if (final) ttsState.finalize();
      return;
    }

    const sentenceSeg = new Intl.Segmenter(undefined, { granularity: "sentence" });
    const sentences = Array.from(sentenceSeg.segment(remaining));
    const lastIdx = sentences.length - 1;

    for (let i = 0; i < sentences.length; i++) {
      const seg = sentences[i];
      // Mid-stream the trailing segment is usually unfinished - hold it back.
      // On finalize every segment is considered complete.
      const isTerminal = i < lastIdx || final;
      if (!isTerminal) break;

      const chunk = seg.segment.trim();
      if (chunk) ttsState.feedSentence(chunk);
      this.ttsCursor += seg.segment.length;
    }

    if (final) ttsState.finalize();
  }

  private cancelStreamBuffer() {
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
    this.flushStreamBuffer();
  }

  /** Common closeout shared by finish/pauseForToolCalls/recordError: drain
   *  the buffer, freeze the reasoning duration onto the bubble, and clear
   *  the streaming flags. Callers that need the prior `messageId` index
   *  (finish, recordError) must capture it BEFORE calling this. */
  private quiesceStream(): void {
    this.cancelStreamBuffer();
    this.finalizeReasoningDuration();
    this.isActive = false;
    this.messageId = null;
  }

  async finish() {
    const idx = this.getActiveIndex();
    this.quiesceStream();
    const finalText = idx >= 0 ? (messagesState.messages[idx]?.content as string) || "" : "";
    void this.feedTTS(finalText, true);
    await persistenceState.flushSave();
  }

  /** Attach the OpenAI tool_calls emitted in the final chunk of the current
   *  streaming assistant message so edit-and-resend can re-materialize the
   *  tool-role messages deterministically. Does NOT clear the streaming slot.
   *  The tool-call loop in stream.ts handles the handoff explicitly. */
  setPendingToolCalls(calls: PendingToolCall[]): void {
    const idx = this.getActiveIndex();
    if (idx < 0) return;
    messagesState.messages[idx] = {
      ...messagesState.messages[idx],
      pendingToolCalls: calls,
    };
  }

  /** Close out the current streaming assistant slot when the model is about
   *  to hand off to tool calls. Unlike finish(), does not trigger a TTS
   *  finalize (no prose was produced) and does not persist the empty bubble
   *  - the assistant message will be rewritten on the next hop. */
  pauseForToolCalls(): void {
    this.quiesceStream();
    this.resetTTSPlayback();
  }

  recordError(errorType: LLMErrorType, detail?: string) {
    const idx = this.getActiveIndex();
    this.quiesceStream();
    const content = detail ? `${errorType}\n${detail}` : errorType;
    if (idx >= 0) {
      const existing = messagesState.messages[idx];
      messagesState.messages[idx] = {
        ...(existing.id ? { id: existing.id } : {}),
        role: "error",
        content,
      };
    }
    void persistenceState.flushSave();
  }

  /** Cancel an active stream as part of `interruptStreaming`. Writes a
   *  `_User interrupted._` marker into the assistant bubble so the user sees
   *  why the answer stopped, then clears the streaming flags. Caller is
   *  responsible for the surrounding orchestration (tool cancellation,
   *  HTTP abort, save flush). */
  cancel(): void {
    if (!this.isActive) return;
    this.cancelStreamBuffer();
    this.resetTTSPlayback();
    this.finalizeReasoningDuration();

    const idx = this.getActiveIndex();
    if (idx >= 0) {
      if (this.firstChunkReceived) {
        const current = messagesState.messages[idx].content;
        if (typeof current === "string") {
          messagesState.messages[idx] = {
            ...messagesState.messages[idx],
            content: current + "\n\n> _User interrupted._",
          };
        }
      } else {
        messagesState.messages[idx] = {
          ...messagesState.messages[idx],
          content: "> _User interrupted._",
        };
      }
    }

    this.isActive = false;
    this.firstChunkReceived = false;
    this.messageId = null;
  }

  /** Abort the active stream without emitting an interrupt marker. Used when
   *  the ongoing assistant message is about to be spliced away (deleteAgent /
   *  reprocess) - leaving a "_User interrupted._" note on a message that's
   *  already being removed would be nonsensical. */
  abortSilently(): void {
    if (!this.isActive) return;
    this.cancelStreamBuffer();
    this.resetTTSPlayback();
    this.isActive = false;
    this.firstChunkReceived = false;
    this.reasoningStartTime = null;
    this.messageId = null;
    this.reasoningId = null;
    interruptCurrentStream();
  }

  /** Stop everything the user can interrupt: the streaming bubble (with its
   *  user-facing marker), every in-flight tool call, and the outer LLM HTTP
   *  request. Tool cancellation runs BEFORE the HTTP abort + save flush so
   *  the sidecar's `tool_cancelled` frames land while the bubbles are still
   *  on screen and `resolveToolCall` can stamp the terminal status. */
  async interruptStreaming(): Promise<void> {
    if (!this.isActive && !messagesState.hasActiveToolCall) return;

    this.cancel();

    await Promise.all(this.interruptListeners.map((fn) => fn()));
    // Abort the outer LLM HTTP stream (no-op when already settled). Kept
    // outside the `isActive` branch so tool-only turns still stop the parent
    // `sendMessages` loop. Its controller is live until the tool-call chain
    // finishes.
    interruptCurrentStream();
    await persistenceState.flushSave();
  }

  /** Drop every streaming-related field back to its initial state. Called by
   *  `sessionsState.resetAll` so a session boundary doesn't carry stream
   *  half-state into the next session. Does NOT abort the HTTP stream
   *  itself; orchestration callers that need that should call
   *  `interruptStreaming` first. */
  resetForSession(): void {
    this.isActive = false;
    this.firstChunkReceived = false;
    this.messageId = null;
    this.reasoningId = null;
    this.streamBuffer = "";
    this.ttsCursor = 0;
    this.reasoningStartTime = null;
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
  }
}

export const streamingState = new StreamingState();
