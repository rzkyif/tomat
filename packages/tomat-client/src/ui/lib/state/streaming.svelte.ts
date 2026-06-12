/**
 * Live LLM-stream layer. The actual LLM call + tool-call orchestration runs
 * server-side in tomat-core, and the server owns message identity and order:
 * every chat-born message arrives as a `chat.message` snapshot (birth, then
 * a final persisted form) and its text streams in via `chat.delta` frames
 * keyed by the server-minted message id. This module:
 *   - sends chat.start / chat.interrupt WS frames
 *   - reduces chat.message / chat.delta / tool.* frames into messagesState
 *   - drives the TTS feed cursor from the streaming assistant text
 *   - exposes the `isActive`/`hasActiveWork`/`isLive` surface components read.
 */

import type { ErrorCode, Message as ServerMessage, ServerToClientFrame } from "@tomat/shared";
import { type LLMErrorType, makeMessageId, type Message } from "$lib/shared/types";
import { stripEmojisForTTS, stripMarkdownForTTS } from "$lib/shared/text";
import { buildToolsHint } from "$lib/shared/system-prompt";
import { cores } from "$lib/core";
import { getLogger } from "$lib/shared/log";
import { messagesState } from "./messages.svelte";
import { permissionState } from "./permissions.svelte";
import { sessionsState } from "./sessions.svelte";
import { settingsState } from "./settings.svelte";
import { ttsState } from "./tts.svelte";
import { viewState } from "./view.svelte";

const log = getLogger("streaming");

type InterruptListener = () => void | Promise<void>;

class StreamingState {
  isActive = $state(false);
  /** True between sending chat.start (or a tool final mid-turn) and the next
   *  reasoning/assistant birth. Drives the loading-sentinel spinner, covering
   *  both the pre-first-token gap and the between-hops prompt processing on
   *  slow local models. */
  awaitingFirstDelta = $state(false);
  turnAnchorId = $state<string | null>(null);
  streamId = $state<string | null>(null);
  /** Ids of messages born in the in-flight turn that haven't received their
   *  final snapshot yet. Drives per-bubble streaming affordances. */
  liveIds = $state<ReadonlySet<string>>(new Set());

  hasActiveWork = $derived(this.isActive || messagesState.hasActiveToolCall);

  // TTS feed target + cursor into its stripped text. Ids are server-minted
  // and never change, so no handoff rewrites are needed; a new assistant
  // bubble claims the feed only when playback is idle.
  private ttsTargetId: string | null = null;
  private ttsCursor = 0;
  // Whether this turn has seen an assistant birth yet: the first one starts
  // the TTS stream outright, later hops only claim it when idle.
  private turnHadAssistant = false;
  private interruptListeners: InterruptListener[] = [];
  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeConn: (() => void) | null = null;

  isLive(id: string | undefined): boolean {
    return id !== undefined && this.liveIds.has(id);
  }

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
    this.awaitingFirstDelta = true;
    this.turnHadAssistant = false;
    this.liveIds = new Set();
    this.ttsTargetId = null;
    this.ttsCursor = 0;
    const streamId = makeMessageId();
    this.streamId = streamId;
    // The system bubble holds the effective prompt for this turn (base +
    // context block + snippet overrides), kept current by addUserMessage and
    // the edit flows. Sending its exact content keeps the bubble truthful:
    // what the UI shows as "the system prompt" is what the model receives.
    // The tools hint rides along separately; core appends it iff tools
    // survive the filter, and mirrors that on the tool_filter message's
    // `toolsSent` so onFrame can append the same hint to the bubble.
    const systemMsg = messagesState.messages.find((m) => m.role === "system");
    const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;
    const toolsHint = buildToolsHint() || undefined;
    cores()
      .api()
      .chat.start(streamId, sessionId, modelUsed, {
        systemPrompt,
        toolsHint,
        anchorMessageId: this.turnAnchorId ?? undefined,
      });
  }

  private onFrame(frame: ServerToClientFrame): void {
    if (frame.kind === "chat.message" && frame.streamId === this.streamId) {
      this.onChatMessage(frame.message as ServerMessage, frame.afterId, frame.final);
      return;
    }
    if (frame.kind === "chat.delta" && frame.streamId === this.streamId) {
      const full = messagesState.appendDelta(frame.messageId, frame.delta);
      if (full !== null && frame.messageId === this.ttsTargetId) {
        this.feedTTS(full, false);
      }
      return;
    }
    if (frame.kind === "chat.usage" && frame.streamId === this.streamId) {
      messagesState.tokenUsage = frame.tokenUsage;
      return;
    }
    if (frame.kind === "chat.done" && frame.streamId === this.streamId) {
      this.finish();
      return;
    }
    if (frame.kind === "chat.error" && frame.streamId === this.streamId) {
      this.recordError(frame.code as LLMErrorType, frame.message);
      return;
    }
    if (
      frame.kind === "tool.progress" ||
      frame.kind === "tool.askuser_request" ||
      frame.kind === "tool.permission_request" ||
      frame.kind === "tool.log" ||
      frame.kind === "tool.result" ||
      frame.kind === "tool.error" ||
      frame.kind === "tool.cancelled"
    ) {
      if (frame.kind === "tool.permission_request") {
        // Drives UserInput's permission mode globally (the bubble state
        // alone can't: UserInput isn't per-message).
        permissionState.set(frame);
      } else if (
        frame.kind === "tool.result" ||
        frame.kind === "tool.error" ||
        frame.kind === "tool.cancelled"
      ) {
        // The call ended some other way (timeout, cancel, worker death)
        // while a request was still pending; drop it so the input returns
        // to normal.
        permissionState.clearForCall(frame.callId);
      }
      messagesState.applyToolEvent(frame);
    }
  }

  private onChatMessage(msg: ServerMessage, afterId: string | null, final: boolean): void {
    messagesState.applyServerMessage(msg, afterId);
    const local = msg as unknown as Message;
    if (local.role === "assistant" || local.role === "reasoning") {
      this.awaitingFirstDelta = false;
    }
    if (!final) {
      const next = new Set(this.liveIds);
      next.add(msg.id);
      this.liveIds = next;
      if (local.role === "assistant") this.claimTTS(msg.id);
      return;
    }
    // Final snapshot.
    if (this.liveIds.has(msg.id)) {
      const next = new Set(this.liveIds);
      next.delete(msg.id);
      this.liveIds = next;
    }
    if (local.role === "assistant" && msg.id === this.ttsTargetId) {
      const text = typeof local.content === "string" ? local.content : "";
      this.feedTTS(text, true);
    }
    // A finished tool call means the next hop's prompt is processing; bring
    // the spinner back until that hop's first reasoning/assistant birth.
    if (local.role === "tool" && this.isActive) {
      this.awaitingFirstDelta = true;
    }
    // Core appended the tools hint to this turn's system prompt; mirror it
    // into the system bubble so it keeps showing exactly what the model
    // received.
    if (local.role === "tool_filter" && local.status === "complete" && (local.toolsSent ?? 0) > 0) {
      messagesState.appendSystemToolsHint(buildToolsHint());
    }
  }

  /** Point the TTS feed at an assistant message. The turn's first assistant
   *  bubble starts the stream outright; later hops only claim the feed when
   *  playback is idle, so hop-1 speech is never cut mid-sentence. */
  private claimTTS(messageId: string): void {
    if (!this.turnHadAssistant) {
      this.turnHadAssistant = true;
      ttsState.startStream(messageId);
      this.ttsTargetId = messageId;
      this.ttsCursor = 0;
      return;
    }
    if (ttsState.liveSourceCount === 0 && !ttsState.synthInflight) {
      ttsState.currentMessageId = messageId;
      this.ttsTargetId = messageId;
      this.ttsCursor = 0;
    }
  }

  private feedTTS(fullText: string, final: boolean): void {
    const settings = settingsState.currentSettings;
    if (!settings["tts.enabled"]) return;
    if (!ttsState.loaded) return;
    if (
      ttsState.currentMessageId !== null &&
      this.ttsTargetId !== null &&
      ttsState.currentMessageId !== this.ttsTargetId
    )
      return;
    let stripped = stripMarkdownForTTS(fullText);
    if (!settings["tts.spellOutEmojis"]) stripped = stripEmojisForTTS(stripped);
    // Speech belongs to the chat view: navigating away resets playback (see
    // viewState.navigate), and this guard keeps a still-running stream from
    // re-arming it at the next sentence boundary. The cursor skips what
    // streamed while away, so returning mid-stream resumes with new
    // sentences only.
    if (viewState.pendingMode !== "chat") {
      this.ttsCursor = stripped.length;
      return;
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
      const isTerminal = i < lastIdx || final;
      if (!isTerminal) break;
      const chunk = seg.segment.trim();
      if (chunk) ttsState.feedSentence(chunk);
      this.ttsCursor += seg.segment.length;
    }
    if (final) ttsState.finalize();
  }

  private finish(): void {
    this.isActive = false;
    this.awaitingFirstDelta = false;
    this.streamId = null;
    this.turnAnchorId = null;
    this.liveIds = new Set();
  }

  recordError(errorType: LLMErrorType | ErrorCode, detail?: string): void {
    // Partial streamed content was already finalized server-side (flagged
    // interrupted), so the error gets its own bubble instead of replacing
    // anything.
    const content = detail ? `${errorType}\n${detail}` : String(errorType);
    messagesState.addMessage({ role: "error", content });
    this.finish();
  }

  /** Stop the turn from the user's side. The UI unlocks immediately;
   *  streamId stays set so the server's interrupted final snapshots (and the
   *  chat.done that follows) still land on the bubbles. */
  cancel(): void {
    if (!this.isActive) return;
    this.resetTTSPlayback();
    this.isActive = false;
    this.awaitingFirstDelta = false;
  }

  /** Abort an in-flight stream because the core connection dropped (e.g. a
   *  dev hot-reload restart). No chat.interrupt frame: the socket is down, so
   *  there's nothing to tell the server. Bubbles that never got their final
   *  snapshot were never persisted; the reconnect reload in sessionsState
   *  resyncs to the server's truth. */
  abortForDisconnect(): void {
    if (!this.isActive) return;
    this.resetTTSPlayback();
    this.finish();
  }

  abortSilently(): void {
    if (!this.isActive) return;
    this.resetTTSPlayback();
    const streamId = this.streamId;
    this.finish();
    if (streamId) cores().api().chat.interrupt(streamId);
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
    this.awaitingFirstDelta = false;
    this.streamId = null;
    this.turnAnchorId = null;
    this.liveIds = new Set();
    this.ttsTargetId = null;
    this.ttsCursor = 0;
    this.turnHadAssistant = false;
  }
}

export const streamingState = new StreamingState();
