import {
  getTextContent,
  makeMessageId,
  type Attachment,
  type LLMErrorType,
  type Message,
  type MessageContent,
  type MessagePart,
  type SessionInfo,
  type TokenUsage,
} from "$lib/shared/types";
import { invoke } from "@tauri-apps/api/core";
import { settingsState } from "./settings.svelte";
import { snippetsState } from "./snippets.svelte";
import { interruptCurrentStream } from "$lib/shared/interrupt";
import {
  deleteSessionAttachments,
  diffRemovedAttachmentPaths,
  ensureMarkdownExtension,
  imageExtFromMime,
  utf8ToBase64,
  writeSessionAttachment,
} from "$lib/shared/attachments";
import { stripMarkdownForTTS } from "$lib/shared/text";
import { applySnippets } from "$lib/shared/snippets";
import {
  applySystemPromptOverride,
  buildContextBlock,
  buildSystemPrompt,
  buildSystemPromptBase,
} from "$lib/shared/systemPrompt";

const DEFAULT_WINDOW_SIZE = 200;
const WINDOW_GROWTH = 200;
const SAVE_DEBOUNCE_MS = 1000;

// Coalesce streaming tokens before pushing into reactive state. At ~30 ms we
// stay under one frame at 30 fps and avoid re-parsing the full markdown blob
// per token (which would dominate at high token rates).
const STREAM_FLUSH_MS = 30;

// Module-level singleton (see export at the bottom). Not torn down in
// production - `beforeunload` listener is intentionally never removed.
class MessagesState {
  messages = $state<Message[]>([]);
  sessionId = $state<string | null>(null);
  sessionTitle = $state<string>("");
  sessionList = $state<SessionInfo[]>([]);
  currentSessionIndex = $state<number>(-1);
  tokenUsage = $state<TokenUsage | null>(null);
  isStreaming = $state(false);
  streamingFirstChunkReceived = $state(false);
  /** Id of the assistant message currently receiving stream chunks. Normally
   *  the newest message (freshly pushed by `startStreaming`), but for
   *  `reprocessAgentMessage` it points at an existing message mid-array so the
   *  regenerated content lands in place without disturbing newer turns. */
  streamingMessageId = $state<string | null>(null);

  visibleWindow = $state(DEFAULT_WINDOW_SIZE);
  visibleMessages = $derived(this.messages.slice(0, this.visibleWindow));
  hasMoreMessages = $derived(this.messages.length > this.visibleWindow);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight: Promise<void> = Promise.resolve();
  private unloadHooked = false;
  private streamBuffer = "";
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsCursor = 0;

  private get storageEnabled(): boolean {
    return settingsState.currentSettings["general.session.storeSessions"] !== false;
  }

  /** Get the default title (formatted timestamp from sessionId) */
  getDefaultTitle(): string {
    if (!this.sessionId) return "";
    const ts = parseInt(this.sessionId, 10);
    if (isNaN(ts)) return this.sessionId;
    const d = new Date(ts);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  addMessage(message: Message) {
    if (!message.id) message.id = makeMessageId();
    this.messages.unshift(message);
    this.scheduleSave();
  }

  /**
   * Flush any pending attachments to disk under the current session directory,
   * then add the resulting user message. Session ID is assigned eagerly so
   * attachments get a stable path even before the first save.
   */
  async addUserMessage(payload: {
    text: string;
    attachments: Attachment[];
    timestamp: number;
    systemPromptOverride?: string;
    effectiveSystemPrompt?: string | null;
  }): Promise<void> {
    // Sending a new message always preempts any previous assistant TTS that
    // might still be playing or queued.
    this.resetTTSPlayback();

    const trimmedText = payload.text.trim();
    if (!this.sessionId) {
      this.sessionId = Date.now().toString();
      this.sessionTitle = this.sessionTitle || this.getDefaultTitle();
    }
    const sessionId = this.sessionId;
    const tsStr = payload.timestamp.toString();

    const parts: MessagePart[] = [];
    if (trimmedText) parts.push({ type: "text", text: trimmedText });

    for (const att of payload.attachments) {
      try {
        if (att.type === "image") {
          const mime = att.mime || "image/png";
          const ext = imageExtFromMime(mime);
          const filename = att.filename.includes(".")
            ? att.filename
            : `${att.filename || "image"}.${ext}`;
          const written = await writeSessionAttachment(sessionId, tsStr, filename, att.pendingData);
          parts.push({
            type: "image_file",
            filename: written.filename,
            path: written.path,
            mime,
          });
        } else {
          const filename = ensureMarkdownExtension(att.filename || "document.md");
          const written = await writeSessionAttachment(
            sessionId,
            tsStr,
            filename,
            utf8ToBase64(att.pendingData),
          );
          parts.push({
            type: "document_file",
            filename: written.filename,
            path: written.path,
          });
        }
      } catch (e) {
        console.error("[messages] Failed to write attachment:", e);
      }
    }

    const content: MessageContent =
      parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
    const userMsg: Message = { id: tsStr, role: "user", content };
    if (payload.systemPromptOverride) {
      userMsg.systemPromptOverride = payload.systemPromptOverride;
    }
    this.messages.unshift(userMsg);
    this.upsertSystemMessage(payload.effectiveSystemPrompt ?? buildSystemPrompt());
    this.scheduleSave();
  }

  /**
   * Keep the visible system-role bubble in sync with what was actually sent
   * to the LLM on the most recent turn. Creates, updates, or removes the
   * system message depending on the `prompts.showSystemPrompt` toggle and
   * whether `effective` is non-empty.
   */
  private upsertSystemMessage(effective: string | null | undefined): void {
    const show = settingsState.currentSettings["prompts.showSystemPrompt"] === true;
    const existingIdx = this.messages.findIndex((m) => m.role === "system");
    const shouldShow = show && typeof effective === "string" && effective.trim().length > 0;

    if (shouldShow) {
      const content = (effective as string).trim();
      if (existingIdx >= 0) {
        this.messages[existingIdx] = {
          ...this.messages[existingIdx],
          content,
        };
      } else {
        this.messages.push({
          id: makeMessageId(),
          role: "system",
          content,
        });
      }
    } else if (existingIdx >= 0) {
      this.messages.splice(existingIdx, 1);
    }
  }

  loadMoreMessages() {
    this.visibleWindow += WINDOW_GROWTH;
  }

  private resetWindow() {
    this.visibleWindow = DEFAULT_WINDOW_SIZE;
  }

  async loadSessionList() {
    if (!this.storageEnabled) {
      this.sessionList = [];
      return;
    }
    try {
      const sessions = (await invoke("list_chat_sessions")) as SessionInfo[];
      this.sessionList = sessions;
      if (this.sessionId) {
        this.currentSessionIndex = sessions.findIndex((s) => s.id === this.sessionId);
      }
    } catch (e) {
      console.error("Failed to load session list:", e);
    }
  }

  private backfillMessageIds(messages: Message[]): Message[] {
    let counter = 0;
    for (const m of messages) {
      if (!m.id) m.id = `load-${Date.now()}-${counter++}`;
    }
    return messages;
  }

  async loadLatest() {
    if (!this.storageEnabled) return;
    try {
      const history = (await invoke("load_latest_chat_history")) as {
        sessionId: string;
        title: string;
        contextUsage: TokenUsage | null;
        messages: Message[];
      } | null;
      if (history && Array.isArray(history.messages)) {
        this.messages = this.backfillMessageIds(history.messages);
        this.sessionId = history.sessionId;
        this.sessionTitle = history.title || this.getDefaultTitle();
        this.tokenUsage = history.contextUsage || null;
        this.resetWindow();
      }
    } catch (e) {
      console.error("Failed to load chat history:", e);
    }
    await this.loadSessionList();
  }

  private resetTTSPlayback() {
    void import("./tts.svelte").then(({ ttsState }) => ttsState.reset());
  }

  async loadSession(sessionId: string) {
    // Drain any debounced save first - otherwise a pending timer could fire
    // after sessionId/messages are replaced and write the new session's data
    // under the new id, silently dropping unpersisted edits to the prior one.
    if (this.sessionId && this.sessionId !== sessionId) {
      await this.flushSave();
    }
    await this.interruptStreaming();
    this.resetTTSPlayback();
    try {
      const history = (await invoke("load_chat_session", { sessionId })) as {
        sessionId: string;
        title: string;
        contextUsage: TokenUsage | null;
        messages: Message[];
      };
      if (history && Array.isArray(history.messages)) {
        this.messages = this.backfillMessageIds(history.messages);
        this.sessionId = history.sessionId;
        this.sessionTitle = history.title || this.getDefaultTitle();
        this.tokenUsage = history.contextUsage || null;
        this.currentSessionIndex = this.sessionList.findIndex((s) => s.id === sessionId);
        this.resetWindow();
      }
    } catch (e) {
      console.error("Failed to load session:", e);
    }
  }

  async navigatePrev() {
    if (this.currentSessionIndex <= 0) return;
    const prevId = this.sessionList[this.currentSessionIndex - 1].id;
    await this.loadSession(prevId);
  }

  async navigateNext() {
    if (this.currentSessionIndex >= this.sessionList.length - 1) return;
    const nextId = this.sessionList[this.currentSessionIndex + 1].id;
    await this.loadSession(nextId);
  }

  async deleteSession() {
    if (!this.sessionId) return;

    await this.interruptStreaming();
    this.resetTTSPlayback();

    // Cancel (don't flush) any pending save - we're about to remove the file,
    // so persisting it now would just be resurrected and then deleted, or
    // worse, fire after the delete and recreate an orphan.
    this.cancelPendingSave();

    const deletedIndex = this.currentSessionIndex;

    try {
      await invoke("delete_chat_session", { sessionId: this.sessionId });
    } catch (e) {
      console.error("Failed to delete session:", e);
      return;
    }

    this.sessionList = this.sessionList.filter((_, i) => i !== deletedIndex);

    if (this.sessionList.length === 0) {
      this.messages = [];
      this.sessionId = null;
      this.sessionTitle = "";
      this.tokenUsage = null;
      this.isStreaming = false;
      this.streamingFirstChunkReceived = false;
      this.currentSessionIndex = 0;
      this.resetWindow();
    } else if (deletedIndex < this.sessionList.length) {
      await this.loadSession(this.sessionList[deletedIndex].id);
    } else {
      await this.loadSession(this.sessionList[deletedIndex - 1].id);
    }
  }

  async newSession() {
    if (this.sessionId && this.messages.length > 0) {
      await this.flushSave();
    }
    await this.interruptStreaming();
    this.resetTTSPlayback();

    this.messages = [];
    this.sessionId = null;
    this.sessionTitle = "";
    this.tokenUsage = null;
    this.isStreaming = false;
    this.streamingFirstChunkReceived = false;
    this.resetWindow();

    await this.loadSessionList();
    this.currentSessionIndex = this.sessionList.length;
  }

  async updateTitle(title: string) {
    this.sessionTitle = title;
    if (this.sessionId && this.storageEnabled) {
      try {
        await invoke("save_session_title", {
          sessionId: this.sessionId,
          title,
        });
        const idx = this.sessionList.findIndex((s) => s.id === this.sessionId);
        if (idx >= 0) {
          this.sessionList[idx] = { ...this.sessionList[idx], title };
        }
      } catch (e) {
        console.error("Failed to save session title:", e);
      }
    }
  }

  updateTokenUsage(usage: TokenUsage) {
    this.tokenUsage = usage;
    this.scheduleSave();
  }

  /** Debounced trailing-edge save. Prevents write amplification on hot paths
   *  (per-message adds, per-token usage updates). */
  scheduleSave() {
    if (!this.storageEnabled) return;
    this.hookUnloadFlush();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Force any pending scheduled save to run now, and wait for it. */
  async flushSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
    } else {
      await this.saveInFlight;
    }
  }

  /** Drop any pending scheduled save without persisting. Use before operations
   *  that invalidate the current session (e.g. deletion) to prevent the timer
   *  from resurrecting a file that was just removed. */
  private cancelPendingSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private hookUnloadFlush() {
    if (this.unloadHooked || typeof window === "undefined") return;
    this.unloadHooked = true;
    window.addEventListener("beforeunload", () => {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        // Best-effort synchronous flush: send an invoke and let it race with
        // process exit. Tauri's invoke isn't truly sync but the command may
        // still commit before teardown.
        void this.save();
      }
    });
  }

  async save() {
    if (!this.storageEnabled) return;
    // Chain saves so rapid successive calls still serialize in order. The
    // trailing .catch() ensures a single unexpected rejection (e.g. a throw
    // outside the inner try/catch) doesn't wedge every subsequent save
    // behind a permanently rejected promise.
    this.saveInFlight = this.saveInFlight
      .then(async () => {
        try {
          // `addUserMessage` now pre-assigns `sessionId` (so attachments can
          // write into the session directory before the first save), so we
          // can't detect a new session just by checking whether `sessionId`
          // is null. Instead, compare against `sessionList` - if the current
          // session hasn't been registered there yet, this is its first save
          // and we need to refresh the list once the file exists.
          if (!this.sessionId) {
            this.sessionId = Date.now().toString();
            this.sessionTitle = this.sessionTitle || this.getDefaultTitle();
          }
          const isNew = !this.sessionList.some((s) => s.id === this.sessionId);

          await invoke("save_chat_history", {
            messages: $state.snapshot(this.messages),
            sessionId: this.sessionId,
            title: this.sessionTitle || null,
            contextUsage: this.tokenUsage ? $state.snapshot(this.tokenUsage) : null,
          });

          if (isNew) {
            await this.loadSessionList();
          }
        } catch (e) {
          console.error("Failed to save chat history:", e);
        }
      })
      .catch((e) => {
        console.error("[messages] save chain error:", e);
      });
    await this.saveInFlight;
  }

  /** Resolve the array index of the message currently being streamed into.
   *  Returns -1 when there is no active stream or the target has been spliced
   *  away (e.g. user deleted the streaming message). */
  private getStreamingIndex(): number {
    if (this.streamingMessageId === null) return -1;
    return this.messages.findIndex((m) => m.id === this.streamingMessageId);
  }

  startStreaming(modelUsed: "default" | "secondary" = "default") {
    this.isStreaming = true;
    this.streamingFirstChunkReceived = false;
    this.ttsCursor = 0;
    const assistantId = makeMessageId();
    this.streamingMessageId = assistantId;
    void import("./tts.svelte").then(({ ttsState }) => ttsState.startStream(assistantId));
    this.addMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      modelUsed,
    });
  }

  /** Set up for reprocessing an existing assistant message in place. Unlike
   *  `startStreaming`, does not push a new message - streaming will write back
   *  into the existing slot so newer conversation turns stay untouched. */
  beginReprocess(messageId: string): boolean {
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    this.isStreaming = true;
    this.streamingFirstChunkReceived = false;
    this.ttsCursor = 0;
    this.streamingMessageId = messageId;
    // Clear existing content + reasoning so the regenerated output replaces,
    // not appends. Preserve role + id + modelUsed.
    const existing = this.messages[idx];
    this.messages[idx] = {
      ...existing,
      role: "assistant",
      content: "",
      reasoning: undefined,
    };
    void import("./tts.svelte").then(({ ttsState }) => ttsState.startStream(messageId));
    return true;
  }

  appendToStreaming(content: string) {
    const idx = this.getStreamingIndex();
    if (idx < 0) return;
    if (!this.streamingFirstChunkReceived) {
      this.streamingFirstChunkReceived = true;
      this.messages[idx] = { ...this.messages[idx], content: "" };
      this.streamBuffer = "";
    }
    this.streamBuffer += content;
    if (!this.streamFlushTimer) {
      this.streamFlushTimer = setTimeout(() => this.flushStreamBuffer(), STREAM_FLUSH_MS);
    }
  }

  /** Accumulate a reasoning-trace delta onto the currently streaming assistant
   *  message. Written directly (no coalesce) since reasoning token rates are
   *  lower than content rates in practice. */
  appendReasoning(delta: string) {
    if (!delta) return;
    const idx = this.getStreamingIndex();
    if (idx < 0) return;
    const cur = this.messages[idx]?.reasoning ?? "";
    this.messages[idx] = {
      ...this.messages[idx],
      reasoning: cur + delta,
    };
  }

  private flushStreamBuffer() {
    this.streamFlushTimer = null;
    if (!this.streamBuffer) return;
    const idx = this.getStreamingIndex();
    if (idx < 0) {
      this.streamBuffer = "";
      return;
    }
    const cur = (this.messages[idx]?.content as string) || "";
    const next = cur + this.streamBuffer;
    this.messages[idx] = {
      ...this.messages[idx],
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
    const streamingId = this.streamingMessageId;
    if (
      ttsState.currentMessageId !== null &&
      streamingId !== null &&
      ttsState.currentMessageId !== streamingId
    ) {
      return;
    }

    // Strip markdown BEFORE segmenting - Intl.Segmenter isn't markdown-aware
    // and otherwise gets confused by URLs, code fences, table pipes, etc.
    // ttsCursor indexes into the stripped text, not the raw stream.
    const stripped = stripMarkdownForTTS(fullText);
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

  async finishStreaming() {
    this.cancelStreamBuffer();
    const idx = this.getStreamingIndex();
    this.isStreaming = false;
    this.streamingMessageId = null;
    const finalText = idx >= 0 ? (this.messages[idx]?.content as string) || "" : "";
    void this.feedTTS(finalText, true);
    await this.flushSave();
  }

  receiveErrorMessage(errorType: LLMErrorType, detail?: string) {
    this.cancelStreamBuffer();
    const idx = this.getStreamingIndex();
    this.isStreaming = false;
    this.streamingMessageId = null;
    const content = detail ? `${errorType}\n${detail}` : errorType;
    if (idx >= 0) {
      const existing = this.messages[idx];
      this.messages[idx] = { ...(existing.id ? { id: existing.id } : {}), role: "error", content };
    }
    void this.flushSave();
  }

  async interruptStreaming(): Promise<void> {
    if (!this.isStreaming) return;
    this.cancelStreamBuffer();
    void import("./tts.svelte").then(({ ttsState }) => ttsState.reset());

    const idx = this.getStreamingIndex();
    if (idx >= 0) {
      if (this.streamingFirstChunkReceived) {
        const current = this.messages[idx].content;
        if (typeof current === "string") {
          this.messages[idx] = {
            ...this.messages[idx],
            content: current + "\n\n> _User interrupted._",
          };
        }
      } else {
        this.messages[idx] = {
          ...this.messages[idx],
          content: "> _User interrupted._",
        };
      }
    }

    this.isStreaming = false;
    this.streamingFirstChunkReceived = false;
    this.streamingMessageId = null;
    interruptCurrentStream();
    await this.flushSave();
  }

  /** Abort the active stream without emitting an interrupt marker. Used when
   *  the ongoing assistant message is about to be spliced away (deleteAgent /
   *  reprocess) - leaving a "_User interrupted._" note on a message that's
   *  already being removed would be nonsensical. */
  private abortStreamSilently(): void {
    if (!this.isStreaming) return;
    this.cancelStreamBuffer();
    void import("./tts.svelte").then(({ ttsState }) => ttsState.reset());
    this.isStreaming = false;
    this.streamingFirstChunkReceived = false;
    this.streamingMessageId = null;
    interruptCurrentStream();
  }

  /** Update any user message by id and regenerate the response. If no id is
   *  provided, falls back to the most recent user message. */
  async updateUserMessage(messageId: string | undefined, content: MessageContent) {
    await this.interruptStreaming();
    // interruptStreaming only stops TTS if something was actively streaming.
    // When editing a message with a settled assistant response, the response
    // is about to be discarded (either spliced out on delete, or replaced by
    // the resend), so any replay-mode TTS tied to it must stop too.
    this.resetTTSPlayback();

    const userIdx = messageId
      ? this.messages.findIndex((m) => m.role === "user" && m.id === messageId)
      : this.messages.findIndex((m) => m.role === "user");
    if (userIdx < 0) return;

    const prevContent = this.messages[userIdx].content;

    const isEmpty =
      typeof content === "string"
        ? !content.trim()
        : content.every((p) => p.type === "text" && !p.text.trim());

    // Reject clearing the sole user message of a session: leaving the session
    // with zero user messages orphans the session file and drops any system
    // message + attachments that belonged to this turn.
    if (isEmpty) {
      const userCount = this.messages.filter((m) => m.role === "user").length;
      if (userCount <= 1) {
        console.warn("[messages] refusing to empty the only user message of this session");
        return;
      }
    }

    const removedPaths = diffRemovedAttachmentPaths(prevContent, content);

    if (isEmpty) {
      this.messages.splice(0, userIdx + 1);
      if (removedPaths.length > 0) {
        void deleteSessionAttachments(removedPaths);
      }
      await this.flushSave();
      return;
    }

    // Re-apply snippet expansion over the edited text so retyped `@triggers`
    // take effect on resend. Attachments are preserved verbatim.
    const rawText = getTextContent(content);
    const { userText, systemOverride } = applySnippets(rawText, snippetsState.snippets);
    const systemPromptOverride = systemOverride
      ? (applySystemPromptOverride(buildSystemPromptBase(), systemOverride, buildContextBlock()) ??
        undefined)
      : undefined;
    const effectiveSystemPrompt = systemPromptOverride ?? buildSystemPrompt();

    const expandedContent: MessageContent = (() => {
      if (typeof content === "string") return userText;
      const nonText = (content as MessagePart[]).filter((p) => p.type !== "text");
      const parts: MessagePart[] = [];
      if (userText) parts.push({ type: "text", text: userText });
      parts.push(...nonText);
      if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
      return parts;
    })();

    const updatedMsg: Message = { role: "user", content: expandedContent };
    if (this.messages[userIdx].id) updatedMsg.id = this.messages[userIdx].id;
    if (systemPromptOverride) updatedMsg.systemPromptOverride = systemPromptOverride;
    this.messages[userIdx] = updatedMsg;

    if (removedPaths.length > 0) {
      void deleteSessionAttachments(removedPaths);
    }

    if (userIdx > 0) {
      this.messages.splice(0, userIdx);
    }

    const isFirstMessage = this.messages.filter((m) => m.role === "user").length === 1;
    if (isFirstMessage) {
      this.sessionTitle = this.getDefaultTitle();
    }

    this.upsertSystemMessage(effectiveSystemPrompt);

    await this.flushSave();

    const { sendMessages } = await import("$lib/sidecar/llm");
    await sendMessages();
  }

  /** Back-compat wrapper: update the most recent user message. */
  async updateLastUserMessage(content: MessageContent) {
    await this.updateUserMessage(undefined, content);
  }

  /** Delete a user message along with its paired assistant/error response. If
   *  this empties the session of user messages, remove the session entirely. */
  async deleteUserMessage(messageId: string) {
    await this.interruptStreaming();
    this.resetTTSPlayback();

    const userIdx = this.messages.findIndex((m) => m.role === "user" && m.id === messageId);
    if (userIdx < 0) return;

    // newest-first: the paired response (generated AFTER this user msg) sits
    // one slot lower. Only splice it if it's actually an assistant/error.
    const pairedIdx =
      userIdx > 0 &&
      (this.messages[userIdx - 1].role === "assistant" ||
        this.messages[userIdx - 1].role === "error")
        ? userIdx - 1
        : userIdx;

    const removedPaths = diffRemovedAttachmentPaths(this.messages[userIdx].content, "");

    const deleteCount = userIdx - pairedIdx + 1;
    this.messages.splice(pairedIdx, deleteCount);

    if (removedPaths.length > 0) {
      void deleteSessionAttachments(removedPaths);
    }

    const remainingUsers = this.messages.filter((m) => m.role === "user").length;
    if (remainingUsers === 0) {
      await this.deleteSession();
      return;
    }

    await this.flushSave();
  }

  /** Regenerate a specific assistant message in place. Only messages
   *  chronologically before the target are used as context; newer turns stay
   *  untouched. */
  async reprocessAgentMessage(messageId: string) {
    if (this.isStreaming) return;
    this.resetTTSPlayback();

    const agentIdx = this.messages.findIndex(
      (m) => (m.role === "assistant" || m.role === "error") && m.id === messageId,
    );
    if (agentIdx < 0) return;

    const { reprocessMessage } = await import("$lib/sidecar/llm");
    await reprocessMessage(messageId);
  }

  /** Delete an assistant/error message. Safe to call on a currently-streaming
   *  message - aborts generation silently first. */
  async deleteAgentMessage(messageId: string) {
    const idx = this.messages.findIndex(
      (m) => (m.role === "assistant" || m.role === "error") && m.id === messageId,
    );
    if (idx < 0) return;

    const isStreamingThis = this.isStreaming && idx === 0;
    if (isStreamingThis) {
      this.abortStreamSilently();
    }
    this.resetTTSPlayback();

    this.messages.splice(idx, 1);

    await this.flushSave();
  }
}

export const messagesState = new MessagesState();
