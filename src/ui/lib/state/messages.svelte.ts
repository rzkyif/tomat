/**
 * The big chat-state store. Holds the active conversation's messages,
 * handles streaming chunks coming back from the LLM, manages session
 * persistence (load, save, switch, delete), feeds assistant output into
 * the TTS queue, and exposes derived slices the UI uses for windowed
 * rendering.
 */

import {
  getTextContent,
  makeMessageId,
  type AskUserAnswer,
  type AskUserQuestion,
  type Attachment,
  type LLMErrorType,
  type Message,
  type MessageContent,
  type MessagePart,
  type PendingToolCall,
  type RelevantToolsState,
  type SessionInfo,
  type TokenUsage,
  type ToolCallLogLine,
  type ToolCallState,
  type ToolCallStatus,
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
import { stripEmojisForTTS, stripMarkdownForTTS } from "$lib/shared/text";
import { applySnippets } from "$lib/shared/snippets";
import {
  applySystemPromptOverride,
  buildContextBlock,
  buildSystemPrompt,
  buildSystemPromptBase,
} from "$lib/shared/systemPrompt";

/** Initial number of messages rendered for a session. Large enough to cover
 *  a typical working conversation without paying to mount thousands of
 *  history turns on session load. Extra turns are revealed in
 *  `WINDOW_GROWTH`-sized chunks when the user scrolls to the top. */
const DEFAULT_WINDOW_SIZE = 200;
/** How many additional older messages to mount per "load more" step. */
const WINDOW_GROWTH = 200;
/** Trailing-edge debounce for `saveSessionToDisk`. At 1s, rapid edits (user
 *  typing + tool streaming) coalesce into one write instead of fanning out
 *  dozens of tmp-file renames per second. */
const SAVE_DEBOUNCE_MS = 1000;

/** Coalesce streaming tokens before pushing into reactive state. At ~30 ms we
 *  stay under one frame at 30 fps and avoid re-parsing the full markdown blob
 *  per token (which would dominate at high token rates). */
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
  /** Id of the `role: "reasoning"` message currently receiving reasoning
   *  chunks. Lazily created on the first reasoning delta and cleared when the
   *  first content chunk arrives (or the stream finishes / errors). Lives in
   *  its own bubble, separate from the paired assistant content message. */
  streamingReasoningId = $state<string | null>(null);

  visibleWindow = $state(DEFAULT_WINDOW_SIZE);
  visibleMessages = $derived(this.messages.slice(0, this.visibleWindow));
  hasMoreMessages = $derived(this.messages.length > this.visibleWindow);

  /** Any tool call bubble currently in a non-terminal state. Drives the
   *  unified "interrupt" affordance in UserInput so tool calls can be stopped
   *  the same way an LLM stream can. */
  hasActiveToolCall = $derived(
    this.messages.some(
      (m) =>
        !!m.toolCall &&
        (m.toolCall.status === "pending" ||
          m.toolCall.status === "running" ||
          m.toolCall.status === "awaiting_user"),
    ),
  );
  /** True whenever there is something the user could interrupt: either an
   *  in-flight LLM stream or any active tool call. */
  hasActiveWork = $derived(this.isStreaming || this.hasActiveToolCall);

  /** Callback registered by toolkitsState so interruptStreaming() can cancel
   *  every active tool call without messagesState importing toolkitsState
   *  (which would create a circular dependency). */
  private toolCancelHandler: (() => void) | null = null;
  setToolCancelHandler(fn: () => void): void {
    this.toolCancelHandler = fn;
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight: Promise<void> = Promise.resolve();
  private unloadHooked = false;
  private streamBuffer = "";
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsCursor = 0;
  /** Wall-clock start of the current assistant turn's reasoning trace.
   *  Set on the first reasoning delta, cleared when the duration is written
   *  onto the message (on first content chunk or on finish). */
  private reasoningStartTime: number | null = null;

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
    if (settingsState.currentSettings["tools.enabled"]) {
      this.upsertToolFilterMessage(userMsg.id!, {
        status: "filtering",
        phase1: null,
        phase2: null,
        alwaysAvailable: null,
      });
    }
    this.scheduleSave();
  }

  /**
   * Public wrapper for `upsertSystemMessage`. Lets the LLM dispatch refresh
   * the visible system-prompt bubble with the turn-final prompt (including
   * the tools hint) right before sending.
   */
  setDisplaySystemPrompt(effective: string | null | undefined): void {
    this.upsertSystemMessage(effective);
  }

  /** Stable id convention: every tool_filter message is paired 1:1 with a
   *  user message via this suffix. Lets the lifecycle hooks (reprocess, edit,
   *  delete) find the right bubble without walking neighbouring indices. */
  private toolFilterIdFor(userMessageId: string): string {
    return `${userMessageId}-filter`;
  }

  /**
   * Create or update the tool_filter bubble paired with a user message. The
   * bubble is inserted at index 0 (newest-first order) so it visually sits
   * between the user message and the assistant response.
   */
  upsertToolFilterMessage(userMessageId: string, state: RelevantToolsState): void {
    const id = this.toolFilterIdFor(userMessageId);
    const existingIdx = this.messages.findIndex((m) => m.role === "tool_filter" && m.id === id);
    if (existingIdx >= 0) {
      this.messages[existingIdx] = {
        ...this.messages[existingIdx],
        relevantTools: state,
      };
    } else {
      this.messages.unshift({
        id,
        role: "tool_filter",
        content: "",
        relevantTools: state,
      });
    }
    this.scheduleSave();
  }

  /** Patch the tool_filter bubble paired with `userMessageId`. No-op if the
   *  bubble doesn't exist (e.g. tool use was disabled when the user message
   *  was added). */
  updateRelevantTools(userMessageId: string, patch: Partial<RelevantToolsState>): void {
    const id = this.toolFilterIdFor(userMessageId);
    const idx = this.messages.findIndex((m) => m.role === "tool_filter" && m.id === id);
    if (idx < 0) return;
    const existing = this.messages[idx].relevantTools;
    if (!existing) return;
    this.messages[idx] = {
      ...this.messages[idx],
      relevantTools: { ...existing, ...patch },
    };
    this.scheduleSave();
  }

  /** Remove the tool_filter bubble paired with `userMessageId`. Used when the
   *  paired user message is deleted. */
  removeToolFilterMessage(userMessageId: string): void {
    const id = this.toolFilterIdFor(userMessageId);
    const idx = this.messages.findIndex((m) => m.role === "tool_filter" && m.id === id);
    if (idx < 0) return;
    this.messages.splice(idx, 1);
  }

  /**
   * Keep the system-role message in sync with what was actually sent to the
   * LLM on the most recent turn. Always reflected in the array (and therefore
   * persisted with the session) so toggling `prompts.showSystemPrompt` later
   * can reveal it without a round-trip; the toggle is enforced at render time.
   */
  private upsertSystemMessage(effective: string | null | undefined): void {
    const existingIdx = this.messages.findIndex((m) => m.role === "system");
    const hasContent = typeof effective === "string" && effective.trim().length > 0;

    if (hasContent) {
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
      // Freeze any tool-call bubbles that were mid-flight when the app was
      // closed. The worker they were running in is long gone; leaving them
      // as "running" would produce a UI spinner that never stops and would
      // also leak into materializeContext (which filters by status). Set
      // them to "cancelled" so the user sees a clear terminal state.
      if (
        m.role === "tool" &&
        m.toolCall &&
        m.toolCall.status !== "complete" &&
        m.toolCall.status !== "failed" &&
        m.toolCall.status !== "cancelled"
      ) {
        m.toolCall = {
          ...m.toolCall,
          status: "cancelled",
          error: m.toolCall.error ?? "interrupted: session was reloaded",
        };
      }
      // Same idea for tool_filter bubbles: any "filtering" status that
      // survived to disk represents a session reload mid-filter. Freeze it as
      // an error so the spinner doesn't run forever.
      if (m.role === "tool_filter" && m.relevantTools && m.relevantTools.status === "filtering") {
        m.relevantTools = {
          ...m.relevantTools,
          status: "error",
          errorMessage: m.relevantTools.errorMessage ?? "interrupted: session was reloaded",
        };
      }
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

    // Cancel any pending save and drain the in-flight chain before the delete.
    // If a save completes *after* the directory is removed, it resurrects the
    // session file and leaves the UI pointing at a now-orphaned id.
    this.cancelPendingSave();
    await this.saveInFlight;

    const sessionToDelete = this.sessionId;
    const deletedIndex = this.sessionList.findIndex((s) => s.id === sessionToDelete);
    const remaining = this.sessionList.filter((s) => s.id !== sessionToDelete);

    // Clear in-memory session state *before* invoking the backend delete and
    // any follow-up loadSession(). Otherwise loadSession's preemptive
    // flushSave() sees the stale id + empty messages array and rewrites the
    // deleted session back to disk; subsequent sends also wire up against the
    // phantom id and silently drop the user's next message.
    this.messages = [];
    this.sessionId = null;
    this.sessionTitle = "";
    this.tokenUsage = null;
    this.isStreaming = false;
    this.streamingFirstChunkReceived = false;
    this.streamingMessageId = null;
    this.resetWindow();

    try {
      await invoke("delete_chat_session", { sessionId: sessionToDelete });
    } catch (e) {
      console.error("Failed to delete session:", e);
    }

    this.sessionList = remaining;

    if (remaining.length === 0) {
      this.currentSessionIndex = 0;
      return;
    }

    // Pick the session that slid into the deleted slot, or the previous one
    // if we deleted the tail. Fall back to the first when the deleted id
    // wasn't in the list (deletedIndex === -1).
    const nextIdx =
      deletedIndex < 0 ? 0 : deletedIndex < remaining.length ? deletedIndex : remaining.length - 1;
    await this.loadSession(remaining[nextIdx].id);
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

  /** Build a persistence-safe snapshot of `messages`. Live runtime state is
   *  untouched; this only filters/transforms the SNAPSHOT we send to disk so
   *  in-progress states don't survive an app close/restart cycle. The
   *  matching defense-in-depth lives in `backfillMessageIds`. */
  private sanitizeSnapshotForSave(): Message[] {
    const snapshot = $state.snapshot(this.messages) as Message[];
    const streamingId = this.streamingMessageId;
    const out: Message[] = [];
    for (const m of snapshot) {
      // Drop the assistant message currently mid-stream; it'll be persisted
      // on the next flushSave after finishStreaming. Keeping it here would
      // save half-written content that we can never resume.
      if (this.isStreaming && streamingId !== null && m.id === streamingId) {
        continue;
      }
      // Tool calls in non-terminal status: rewrite to a cancelled snapshot
      // so reload doesn't show a stuck spinner.
      if (
        m.role === "tool" &&
        m.toolCall &&
        m.toolCall.status !== "complete" &&
        m.toolCall.status !== "failed" &&
        m.toolCall.status !== "cancelled"
      ) {
        out.push({
          ...m,
          toolCall: {
            ...m.toolCall,
            status: "cancelled",
            error: m.toolCall.error ?? "interrupted: app was closed",
          },
        });
        continue;
      }
      // Tool filter still in "filtering" status: rewrite to error.
      if (m.role === "tool_filter" && m.relevantTools && m.relevantTools.status === "filtering") {
        out.push({
          ...m,
          relevantTools: {
            ...m.relevantTools,
            status: "error",
            errorMessage: m.relevantTools.errorMessage ?? "interrupted: app was closed",
          },
        });
        continue;
      }
      out.push(m);
    }
    return out;
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
            messages: this.sanitizeSnapshotForSave(),
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
    this.reasoningStartTime = null;
    this.streamingReasoningId = null;
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
    this.reasoningStartTime = null;
    this.streamingReasoningId = null;
    this.ttsCursor = 0;
    this.streamingMessageId = messageId;
    // Drop any prior reasoning bubble paired to this assistant turn. A new
    // one will be lazily created if reasoning fires again on the regenerated
    // run.
    const reasoningIdx = this.messages.findIndex(
      (m) => m.role === "reasoning" && m.pairedAssistantId === messageId,
    );
    if (reasoningIdx >= 0) {
      this.messages.splice(reasoningIdx, 1);
    }
    // Clear existing content so the regenerated output replaces, not appends.
    // Preserve role + id + modelUsed. (Re-find the index in case the prior
    // reasoning splice shifted it.)
    const refreshedIdx = this.messages.findIndex((m) => m.id === messageId);
    if (refreshedIdx < 0) return false;
    const existing = this.messages[refreshedIdx];
    this.messages[refreshedIdx] = {
      ...existing,
      role: "assistant",
      content: "",
    };
    // Reset the paired tool_filter bubble so the spinner shows during the
    // re-run instead of stale phase-1/phase-2 results.
    const pairedUser = this.messages.slice(refreshedIdx + 1).find((m) => m.role === "user");
    if (pairedUser?.id && settingsState.currentSettings["tools.enabled"]) {
      this.upsertToolFilterMessage(pairedUser.id, {
        status: "filtering",
        phase1: null,
        phase2: null,
        alwaysAvailable: null,
      });
    }
    void import("./tts.svelte").then(({ ttsState }) => ttsState.startStream(messageId));
    return true;
  }

  appendToStreaming(content: string) {
    const idx = this.getStreamingIndex();
    if (idx < 0) return;
    if (!this.streamingFirstChunkReceived) {
      this.streamingFirstChunkReceived = true;
      this.finalizeReasoningDuration();
      this.messages[idx] = { ...this.messages[idx], content: "" };
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
    if (this.streamingMessageId === null) return;
    if (this.streamingFirstChunkReceived) return;

    if (this.streamingReasoningId === null) {
      const contentIdx = this.messages.findIndex((m) => m.id === this.streamingMessageId);
      if (contentIdx < 0) return;
      const contentMsg = this.messages[contentIdx];
      const reasoningId = makeMessageId();
      this.streamingReasoningId = reasoningId;
      this.reasoningStartTime = Date.now();
      // Insert immediately after the assistant content message in the
      // newest-first array, which places the reasoning bubble older (higher
      // index) than its paired content, matching the chronological order in
      // which the model emits them.
      this.messages.splice(contentIdx + 1, 0, {
        id: reasoningId,
        role: "reasoning",
        content: delta,
        modelUsed: contentMsg.modelUsed,
        pairedAssistantId: contentMsg.id,
      });
      this.scheduleSave();
      return;
    }

    const idx = this.messages.findIndex((m) => m.id === this.streamingReasoningId);
    if (idx < 0) return;
    const cur = (this.messages[idx].content as string) || "";
    this.messages[idx] = { ...this.messages[idx], content: cur + delta };
  }

  /** Freeze the elapsed reasoning time onto the streaming reasoning bubble so
   *  historic loads can render "Thought for Xs" without live tracking, then
   *  clear the streaming-reasoning slot so subsequent state transitions stop
   *  treating it as live. No-op if no reasoning bubble is currently open. */
  private finalizeReasoningDuration() {
    if (this.streamingReasoningId === null) {
      this.reasoningStartTime = null;
      return;
    }
    const idx = this.messages.findIndex((m) => m.id === this.streamingReasoningId);
    if (idx < 0) {
      this.streamingReasoningId = null;
      this.reasoningStartTime = null;
      return;
    }
    if (this.reasoningStartTime !== null) {
      const duration = Date.now() - this.reasoningStartTime;
      this.messages[idx] = { ...this.messages[idx], reasoningDurationMs: duration };
    }
    this.streamingReasoningId = null;
    this.reasoningStartTime = null;
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

  async finishStreaming() {
    this.cancelStreamBuffer();
    const idx = this.getStreamingIndex();
    this.finalizeReasoningDuration();
    this.isStreaming = false;
    this.streamingMessageId = null;
    const finalText = idx >= 0 ? (this.messages[idx]?.content as string) || "" : "";
    void this.feedTTS(finalText, true);
    await this.flushSave();
  }

  /** Attach the OpenAI tool_calls emitted in the final chunk of the current
   *  streaming assistant message so edit-and-resend can re-materialize the
   *  tool-role messages deterministically. Does NOT clear the streaming slot.
   *  The tool-call loop in llm.ts handles the handoff explicitly. */
  setPendingToolCalls(calls: PendingToolCall[]): void {
    const idx = this.getStreamingIndex();
    if (idx < 0) return;
    this.messages[idx] = {
      ...this.messages[idx],
      pendingToolCalls: calls,
    };
  }

  /** Close out the current streaming assistant slot when the model is about
   *  to hand off to tool calls. Unlike finishStreaming(), does not trigger a
   *  TTS finalize (no prose was produced) and does not persist the empty
   *  bubble - the assistant message will be rewritten on the next hop. */
  finishStreamingForToolCalls(): void {
    this.cancelStreamBuffer();
    this.finalizeReasoningDuration();
    this.isStreaming = false;
    this.streamingMessageId = null;
    void import("./tts.svelte").then(({ ttsState }) => ttsState.reset());
  }

  /** Push a new role:"tool" message representing an active tool invocation.
   *  Returns the message id so callers can update the same slot later. */
  appendToolCall(tc: ToolCallState): string {
    const id = makeMessageId();
    this.addMessage({
      id,
      role: "tool",
      content: "",
      toolCall: tc,
    });
    return id;
  }

  /** Immutably merge `patch` into the ToolCallState of the message whose
   *  toolCall.callId matches. No-op when the call is missing (e.g. the user
   *  deleted the bubble). */
  updateToolCall(callId: string, patch: Partial<ToolCallState>): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing) return;
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: { ...existing, ...patch },
    };
    this.scheduleSave();
  }

  /** Mark a tool call terminated with either a result or an error. Sets the
   *  status too so callers don't have to duplicate that. */
  resolveToolCall(
    callId: string,
    payload: { result?: unknown; error?: string; cancelled?: boolean },
  ): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing) return;
    let status: ToolCallStatus;
    if (payload.cancelled) {
      status = "cancelled";
    } else if (payload.error !== undefined) {
      status = "failed";
    } else {
      status = "complete";
    }
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: {
        ...existing,
        status,
        result: payload.result,
        error: payload.error,
      },
    };
    this.scheduleSave();
  }

  /** Record an askUser request on the bubble so the form renders. */
  setToolCallAskUser(callId: string, requestId: string, questions: AskUserQuestion[]): void {
    this.updateToolCall(callId, {
      status: "awaiting_user",
      askUser: { requestId, questions, answers: null },
    });
  }

  /** Stash the user's answers on the bubble after submit. The WS layer
   *  forwards them back to the worker; this keeps the UI in the right state
   *  while we wait for the next progress / result event. */
  recordToolCallAskUserAnswers(callId: string, answers: AskUserAnswer[]): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing?.askUser) return;
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: {
        ...existing,
        status: "running",
        askUser: { ...existing.askUser, answers },
      },
    };
    this.scheduleSave();
  }

  /** Append a log line visible in the bubble's details disclosure. */
  appendToolCallLog(callId: string, line: ToolCallLogLine): void {
    const idx = this.messages.findIndex((m) => m.toolCall?.callId === callId);
    if (idx < 0) return;
    const existing = this.messages[idx].toolCall;
    if (!existing) return;
    const logs = existing.logs.length >= 200 ? existing.logs.slice(-199) : existing.logs.slice();
    logs.push(line);
    this.messages[idx] = {
      ...this.messages[idx],
      toolCall: { ...existing, logs },
    };
  }

  receiveErrorMessage(errorType: LLMErrorType, detail?: string) {
    this.cancelStreamBuffer();
    const idx = this.getStreamingIndex();
    this.finalizeReasoningDuration();
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
    if (!this.isStreaming && !this.hasActiveToolCall) return;

    if (this.isStreaming) {
      this.cancelStreamBuffer();
      void import("./tts.svelte").then(({ ttsState }) => ttsState.reset());
      this.finalizeReasoningDuration();

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
    }

    // Cancel every in-flight tool call. The sidecar responds with
    // `tool_cancelled` which drives each bubble to its terminal state.
    this.toolCancelHandler?.();
    // Abort the outer LLM HTTP stream (no-op when already settled). Kept
    // outside the `isStreaming` branch so tool-only turns still stop the
    // parent `sendMessages` loop. Its controller is live until the
    // tool-call chain finishes.
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
    this.reasoningStartTime = null;
    this.streamingMessageId = null;
    this.streamingReasoningId = null;
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

    const isFirstMessage = this.messages.filter((m) => m.role === "user").length === 1;
    if (isFirstMessage) {
      this.sessionTitle = this.getDefaultTitle();
    }

    this.upsertSystemMessage(effectiveSystemPrompt);

    await this.flushSave();

    // Regenerate the paired response in place so turns newer than this user
    // message survive the edit. In newest-first order the paired response sits
    // one or more slots above the user message: a tool_filter bubble (when
    // tools are enabled) and/or a reasoning bubble may sit between. Skip past
    // those to land on the content slot that drives reprocessing. Fall back to
    // a fresh send when no paired response exists (edit on a brand-new user
    // message). Skipping tool_filter matters because otherwise we'd fall into
    // sendMessages() with the stale assistant still in context, which llama.cpp
    // rejects as an "assistant prefill" incompatible with enable_thinking.
    let scan = userIdx - 1;
    while (
      scan >= 0 &&
      (this.messages[scan].role === "reasoning" || this.messages[scan].role === "tool_filter")
    )
      scan -= 1;
    const paired = scan >= 0 ? this.messages[scan] : null;
    if (paired && (paired.role === "assistant" || paired.role === "error") && paired.id) {
      const { reprocessMessage } = await import("$lib/sidecar/llm");
      await reprocessMessage(paired.id);
    } else {
      const { sendMessages } = await import("$lib/sidecar/llm");
      await sendMessages();
    }
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

    // Drop the paired tool_filter bubble first so its index doesn't drift
    // under the assistant-pair splice below.
    this.removeToolFilterMessage(messageId);
    const refreshedUserIdx = this.messages.findIndex(
      (m) => m.role === "user" && m.id === messageId,
    );

    // newest-first: the paired response (generated AFTER this user msg) sits
    // one or two slots above. Walk backwards across reasoning bubbles and the
    // assistant/error content bubble so the splice catches the whole turn.
    let pairedIdx = refreshedUserIdx;
    while (pairedIdx > 0) {
      const above = this.messages[pairedIdx - 1];
      if (above.role === "assistant" || above.role === "error" || above.role === "reasoning") {
        pairedIdx -= 1;
      } else {
        break;
      }
    }

    const removedPaths = diffRemovedAttachmentPaths(this.messages[refreshedUserIdx].content, "");

    const deleteCount = refreshedUserIdx - pairedIdx + 1;
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
   *  message - aborts generation silently first. If this empties the session
   *  of user messages, remove the session entirely (symmetric with
   *  deleteUserMessage). */
  /** Delete a reasoning bubble. When the bubble is paired to an assistant
   *  content message (the normal case), delegate to `deleteAgentMessage` so
   *  the whole turn (reasoning + content) goes together; leaving reasoning
   *  without its produced answer makes no sense. Standalone reasoning
   *  (orphaned, shouldn't happen in practice) is removed in place. */
  async deleteReasoningMessage(messageId: string) {
    const idx = this.messages.findIndex((m) => m.role === "reasoning" && m.id === messageId);
    if (idx < 0) return;
    const paired = this.messages[idx].pairedAssistantId;
    if (paired) {
      await this.deleteAgentMessage(paired);
      return;
    }
    this.messages.splice(idx, 1);
    await this.flushSave();
  }

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
    // Drop any reasoning bubble paired to this assistant turn; they live
    // and die together, since the reasoning trace has no meaning without
    // its produced answer (or vice-versa).
    const reasoningIdx = this.messages.findIndex(
      (m) => m.role === "reasoning" && m.pairedAssistantId === messageId,
    );
    if (reasoningIdx >= 0) {
      this.messages.splice(reasoningIdx, 1);
    }

    const remainingUsers = this.messages.filter((m) => m.role === "user").length;
    if (remainingUsers === 0) {
      await this.deleteSession();
      return;
    }

    await this.flushSave();
  }
}

export const messagesState = new MessagesState();
