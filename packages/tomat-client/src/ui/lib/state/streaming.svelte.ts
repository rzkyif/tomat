/**
 * Live LLM-stream layer. The actual LLM call + tool-call orchestration runs
 * server-side in tomat-core; this client-side module:
 *   - sends chat.start / chat.interrupt / tool.cancel / tool.askuser_response
 *     WS frames
 *   - mutates messagesState as chat.chunk / chat.toolfilter / etc. frames arrive
 *   - drives the TTS feed cursor from the streaming assistant text
 *   - exposes the same `isActive`/`hasActiveWork`/`messageId` surface
 *     legacy components already read.
 */

import type { ErrorCode, PendingToolCall, ServerToClientFrame } from "@tomat/shared";
import { type LLMErrorType, makeMessageId } from "$lib/shared/types";
import { stripEmojisForTTS, stripMarkdownForTTS } from "$lib/shared/text";
import { cores } from "$lib/core";
import { getLogger } from "$lib/shared/log";
import { messagesState } from "./messages.svelte";
import { sessionsState } from "./sessions.svelte";
import { settingsState } from "./settings.svelte";
import { ttsState } from "./tts.svelte";

const log = getLogger("streaming");

const STREAM_FLUSH_MS = 30;

type InterruptListener = () => void | Promise<void>;

class StreamingState {
  isActive = $state(false);
  firstChunkReceived = $state(false);
  messageId = $state<string | null>(null);
  turnAnchorId = $state<string | null>(null);
  reasoningId = $state<string | null>(null);
  streamId = $state<string | null>(null);

  hasActiveWork = $derived(this.isActive || messagesState.hasActiveToolCall);

  private streamBuffer = "";
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsCursor = 0;
  // Cached array positions of the active assistant + reasoning messages so the
  // hot streaming path doesn't findIndex() over the whole transcript on every
  // flushed chunk. The id check below makes a stale cache self-correcting: if
  // the array shifted, the fast path misses and we re-scan, so this can never
  // return a wrong index.
  private cachedActiveIdx = -1;
  private cachedReasoningIdx = -1;
  private reasoningStartTime: number | null = null;
  private interruptListeners: InterruptListener[] = [];
  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeConn: (() => void) | null = null;

  onInterrupt(fn: InterruptListener): () => void {
    this.interruptListeners.push(fn);
    return () => {
      const idx = this.interruptListeners.indexOf(fn);
      if (idx >= 0) this.interruptListeners.splice(idx, 1);
    };
  }

  attach(): void {
    if (this.unsubscribeWs) return;
    this.unsubscribeWs = cores().subscribeWs((f) => this.onFrame(f));
    // A core hot-reload (or any disconnect) silently stops the frame stream:
    // no terminal chat.done/chat.error arrives, so isActive (and the spinner)
    // would hang forever. On disconnect, abort the in-flight stream and flip any
    // running tool call to interrupted so the UI unwedges on its own.
    this.unsubscribeConn = cores().subscribeConnectionState((state) => {
      if (state !== "disconnected") return;
      if (this.isActive) {
        log.info("stream aborted: core disconnected");
        this.abortForDisconnect();
      }
      const interrupted = messagesState.interruptActiveToolCalls();
      if (interrupted > 0) {
        log.info(`interrupted ${interrupted} in-flight tool call(s): core disconnected`);
      }
    });
  }

  detach(): void {
    if (this.unsubscribeWs) {
      this.unsubscribeWs();
      this.unsubscribeWs = null;
    }
    if (this.unsubscribeConn) {
      this.unsubscribeConn();
      this.unsubscribeConn = null;
    }
  }

  resetTTSPlayback(): void {
    ttsState.reset();
  }

  private getActiveIndex(): number {
    if (this.messageId === null) return -1;
    const msgs = messagesState.messages;
    if (
      this.cachedActiveIdx >= 0 &&
      this.cachedActiveIdx < msgs.length &&
      msgs[this.cachedActiveIdx]?.id === this.messageId
    ) {
      return this.cachedActiveIdx;
    }
    this.cachedActiveIdx = msgs.findIndex((m) => m.id === this.messageId);
    return this.cachedActiveIdx;
  }

  private getReasoningIndex(): number {
    if (this.reasoningId === null) return -1;
    const msgs = messagesState.messages;
    if (
      this.cachedReasoningIdx >= 0 &&
      this.cachedReasoningIdx < msgs.length &&
      msgs[this.cachedReasoningIdx]?.id === this.reasoningId
    ) {
      return this.cachedReasoningIdx;
    }
    this.cachedReasoningIdx = msgs.findIndex((m) => m.id === this.reasoningId);
    return this.cachedReasoningIdx;
  }

  beginTurn(anchorUserId: string | null): void {
    this.turnAnchorId = anchorUserId;
  }

  start(modelUsed: "default" | "secondary" = "default"): void {
    const sessionId = sessionsState.id;
    if (!sessionId) {
      log.warn("start called without an active session");
      return;
    }
    this.isActive = true;
    this.firstChunkReceived = false;
    this.reasoningStartTime = null;
    this.reasoningId = null;
    this.ttsCursor = 0;
    this.cachedActiveIdx = -1;
    this.cachedReasoningIdx = -1;
    const assistantId = makeMessageId();
    const streamId = makeMessageId();
    this.messageId = assistantId;
    this.streamId = streamId;
    ttsState.startStream(assistantId);
    messagesState.insertAtTurnAnchor({
      id: assistantId,
      role: "assistant",
      content: "",
      modelUsed,
    });
    cores().api().chat.start(streamId, sessionId, modelUsed);
  }

  private onFrame(frame: ServerToClientFrame): void {
    if (frame.kind === "chat.chunk" && frame.streamId === this.streamId) {
      if (frame.contentDelta) this.appendContent(frame.contentDelta);
      if (frame.reasoningDelta) this.appendReasoning(frame.reasoningDelta);
      return;
    }
    if (frame.kind === "chat.toolcall_requested" && frame.streamId === this.streamId) {
      this.setPendingToolCalls(frame.calls);
      return;
    }
    if (frame.kind === "chat.usage" && frame.streamId === this.streamId) {
      messagesState.tokenUsage = frame.tokenUsage;
      return;
    }
    if (frame.kind === "chat.done" && frame.streamId === this.streamId) {
      void this.finish();
      return;
    }
    if (frame.kind === "chat.error" && frame.streamId === this.streamId) {
      this.recordError(frame.code as LLMErrorType, frame.message);
      return;
    }
    if (frame.kind === "chat.toolfilter" && frame.streamId === this.streamId) {
      messagesState.upsertToolFilter({
        status: frame.status,
        phase1: frame.phase1 ?? null,
        phase2: frame.phase2 ?? null,
        alwaysAvailable: frame.alwaysAvailable ?? null,
        errorMessage: frame.errorMessage,
      });
      return;
    }
    if (
      frame.kind === "tool.progress" ||
      frame.kind === "tool.askuser_request" ||
      frame.kind === "tool.log" ||
      frame.kind === "tool.result" ||
      frame.kind === "tool.error" ||
      frame.kind === "tool.cancelled"
    ) {
      messagesState.applyToolEvent(frame);
    }
  }

  appendContent(content: string): void {
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

  appendReasoning(delta: string): void {
    if (!delta) return;
    if (this.messageId === null) return;
    if (this.firstChunkReceived) return;
    if (this.reasoningId === null) {
      const contentIdx = this.getActiveIndex();
      if (contentIdx < 0) return;
      const contentMsg = messagesState.messages[contentIdx];
      const reasoningId = makeMessageId();
      this.reasoningId = reasoningId;
      this.reasoningStartTime = Date.now();
      messagesState.messages.splice(contentIdx + 1, 0, {
        id: reasoningId,
        role: "reasoning",
        content: delta,
        modelUsed: contentMsg.modelUsed,
        pairedAssistantId: contentMsg.id,
      });
      // The reasoning row sits right after the content row; seed its cache.
      this.cachedReasoningIdx = contentIdx + 1;
      return;
    }
    const idx = this.getReasoningIndex();
    if (idx < 0) return;
    const cur = (messagesState.messages[idx].content as string) || "";
    messagesState.messages[idx] = { ...messagesState.messages[idx], content: cur + delta };
  }

  private finalizeReasoningDuration(): void {
    if (this.reasoningId === null) {
      this.reasoningStartTime = null;
      return;
    }
    const idx = this.getReasoningIndex();
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

  private flushStreamBuffer(): void {
    this.streamFlushTimer = null;
    if (!this.streamBuffer) return;
    const idx = this.getActiveIndex();
    if (idx < 0) {
      this.streamBuffer = "";
      return;
    }
    const cur = (messagesState.messages[idx]?.content as string) || "";
    const next = cur + this.streamBuffer;
    messagesState.messages[idx] = { ...messagesState.messages[idx], content: next };
    this.streamBuffer = "";
    void this.feedTTS(next, false);
  }

  private feedTTS(fullText: string, final: boolean): void {
    const settings = settingsState.currentSettings;
    if (!settings["tts.enabled"]) return;
    if (!ttsState.loaded) return;
    const activeId = this.messageId;
    if (
      ttsState.currentMessageId !== null &&
      activeId !== null &&
      ttsState.currentMessageId !== activeId
    )
      return;
    let stripped = stripMarkdownForTTS(fullText);
    if (!settings["tts.spellOutEmojis"]) stripped = stripEmojisForTTS(stripped);
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
      const isTerminal = i < lastIdx || final;
      if (!isTerminal) break;
      const chunk = seg.segment.trim();
      if (chunk) ttsState.feedSentence(chunk);
      this.ttsCursor += seg.segment.length;
    }
    if (final) ttsState.finalize();
  }

  private cancelStreamBuffer(): void {
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
    this.flushStreamBuffer();
  }

  private quiesceStream(): void {
    this.cancelStreamBuffer();
    this.finalizeReasoningDuration();
    this.isActive = false;
    this.messageId = null;
    this.streamId = null;
  }

  async finish(): Promise<void> {
    const idx = this.getActiveIndex();
    this.quiesceStream();
    this.turnAnchorId = null;
    const finalText = idx >= 0 ? (messagesState.messages[idx]?.content as string) || "" : "";
    void this.feedTTS(finalText, true);
  }

  setPendingToolCalls(calls: PendingToolCall[]): void {
    const idx = this.getActiveIndex();
    if (idx < 0) return;
    messagesState.messages[idx] = {
      ...messagesState.messages[idx],
      pendingToolCalls: calls,
    };
  }

  pauseForToolCalls(): void {
    this.quiesceStream();
    this.resetTTSPlayback();
  }

  recordError(errorType: LLMErrorType | ErrorCode, detail?: string): void {
    const idx = this.getActiveIndex();
    this.quiesceStream();
    this.turnAnchorId = null;
    const content = detail ? `${errorType}\n${detail}` : String(errorType);
    if (idx >= 0) {
      const existing = messagesState.messages[idx];
      // Build the replacement as a typed Message. The Message union
      // already carries `role: "error"` as a valid variant, so no cast
      // is needed.
      const replacement: (typeof messagesState.messages)[number] = {
        ...(existing.id ? { id: existing.id } : {}),
        role: "error",
        content,
      };
      messagesState.messages[idx] = replacement;
    }
  }

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
    this.streamId = null;
    this.turnAnchorId = null;
  }

  /** Abort an in-flight stream because the core connection dropped (e.g. a dev
   *  hot-reload restart). Mirrors cancel() but with disconnect wording and no
   *  chat.interrupt frame: the socket is down, so there's nothing to tell the
   *  server (its stream tears down on the closed socket). The note keeps the
   *  partial reply visible until a reconnect reload (sessionsState) resyncs from
   *  the server's truth. */
  abortForDisconnect(): void {
    if (!this.isActive) return;
    const idx = this.getActiveIndex();
    this.resetTTSPlayback();
    this.quiesceStream();
    this.firstChunkReceived = false;
    this.turnAnchorId = null;
    if (idx >= 0) {
      const current = messagesState.messages[idx]?.content;
      messagesState.messages[idx] = {
        ...messagesState.messages[idx],
        content:
          typeof current === "string" && current.length > 0
            ? current + "\n\n> _Disconnected from core; reply interrupted._"
            : "> _Disconnected from core; reply interrupted._",
      };
    }
  }

  abortSilently(): void {
    if (!this.isActive) return;
    this.cancelStreamBuffer();
    this.resetTTSPlayback();
    this.isActive = false;
    this.firstChunkReceived = false;
    this.reasoningStartTime = null;
    this.messageId = null;
    this.reasoningId = null;
    this.turnAnchorId = null;
    if (this.streamId) cores().api().chat.interrupt(this.streamId);
    this.streamId = null;
  }

  async interruptStreaming(): Promise<void> {
    if (!this.isActive && !messagesState.hasActiveToolCall) return;
    const streamId = this.streamId;
    this.cancel();
    await Promise.all(this.interruptListeners.map((fn) => fn()));
    if (streamId) cores().api().chat.interrupt(streamId);
  }

  resetForSession(): void {
    this.isActive = false;
    this.firstChunkReceived = false;
    this.messageId = null;
    this.reasoningId = null;
    this.turnAnchorId = null;
    this.streamId = null;
    this.streamBuffer = "";
    this.ttsCursor = 0;
    this.cachedActiveIdx = -1;
    this.cachedReasoningIdx = -1;
    this.reasoningStartTime = null;
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
  }
}

export const streamingState = new StreamingState();
