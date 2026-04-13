import type {
  LLMErrorType,
  Message,
  MessageContent,
  SessionInfo,
  TokenUsage,
} from "$lib/shared/types";
import { invoke } from "@tauri-apps/api/core";
import { settingsState } from "./settings.svelte";
import { interruptCurrentStream } from "$lib/shared/interrupt";

const DEFAULT_WINDOW_SIZE = 200;
const WINDOW_GROWTH = 200;
const SAVE_DEBOUNCE_MS = 1000;
// Coalesce streaming tokens before pushing into reactive state. At ~30 ms we
// stay under one frame at 30 fps and avoid re-parsing the full markdown blob
// per token (which would dominate at high token rates).
const STREAM_FLUSH_MS = 30;

// Module-level singleton (see export at the bottom). Not torn down in
// production — `beforeunload` listener is intentionally never removed.
class MessagesState {
  messages = $state<Message[]>([]);
  sessionId = $state<string | null>(null);
  sessionTitle = $state<string>("");
  sessionList = $state<SessionInfo[]>([]);
  currentSessionIndex = $state<number>(-1);
  tokenUsage = $state<TokenUsage | null>(null);
  isStreaming = $state(false);
  streamingFirstChunkReceived = $state(false);

  visibleWindow = $state(DEFAULT_WINDOW_SIZE);
  visibleMessages = $derived(this.messages.slice(0, this.visibleWindow));
  hasMoreMessages = $derived(this.messages.length > this.visibleWindow);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight: Promise<void> = Promise.resolve();
  private unloadHooked = false;
  private streamBuffer = "";
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.messages.unshift(message);
    this.scheduleSave();
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
        this.messages = history.messages;
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

  async loadSession(sessionId: string) {
    // Drain any debounced save first — otherwise a pending timer could fire
    // after sessionId/messages are replaced and write the new session's data
    // under the new id, silently dropping unpersisted edits to the prior one.
    if (this.sessionId && this.sessionId !== sessionId) {
      await this.flushSave();
    }
    try {
      const history = (await invoke("load_chat_session", { sessionId })) as {
        sessionId: string;
        title: string;
        contextUsage: TokenUsage | null;
        messages: Message[];
      };
      if (history && Array.isArray(history.messages)) {
        this.messages = history.messages;
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

    // Cancel (don't flush) any pending save — we're about to remove the file,
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
          const isNew = !this.sessionId;
          if (isNew) {
            this.sessionId = Date.now().toString();
            this.sessionTitle = this.sessionTitle || this.getDefaultTitle();
          }

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

  startStreaming() {
    this.isStreaming = true;
    this.streamingFirstChunkReceived = false;
    const settings = settingsState.currentSettings;
    const useThinkingPlaceholder =
      settings["llm.preset"] !== "external" && settings["llm.reasoning"] === "on";
    this.addMessage({
      role: "assistant",
      content: useThinkingPlaceholder ? "Thinking..." : "...",
    });
  }

  appendToStreaming(content: string) {
    if (!this.streamingFirstChunkReceived) {
      this.streamingFirstChunkReceived = true;
      this.messages[0] = { ...this.messages[0], content: "" };
      this.streamBuffer = "";
    }
    this.streamBuffer += content;
    if (!this.streamFlushTimer) {
      this.streamFlushTimer = setTimeout(() => this.flushStreamBuffer(), STREAM_FLUSH_MS);
    }
  }

  private flushStreamBuffer() {
    this.streamFlushTimer = null;
    if (!this.streamBuffer) return;
    const cur = (this.messages[0]?.content as string) || "";
    this.messages[0] = {
      ...this.messages[0],
      content: cur + this.streamBuffer,
    };
    this.streamBuffer = "";
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
    this.isStreaming = false;
    await this.flushSave();
  }

  receiveErrorMessage(errorType: LLMErrorType, detail?: string) {
    this.cancelStreamBuffer();
    this.isStreaming = false;
    const content = detail ? `${errorType}\n${detail}` : errorType;
    this.messages[0] = { role: "error", content };
    void this.flushSave();
  }

  async interruptStreaming(): Promise<void> {
    if (!this.isStreaming) return;
    this.cancelStreamBuffer();

    if (this.streamingFirstChunkReceived) {
      const current = this.messages[0].content;
      if (typeof current === "string") {
        this.messages[0] = {
          ...this.messages[0],
          content: current + "\n\n> _User interrupted._",
        };
      }
    } else {
      this.messages[0] = {
        ...this.messages[0],
        content: "> _User interrupted._",
      };
    }

    this.isStreaming = false;
    this.streamingFirstChunkReceived = false;
    interruptCurrentStream();
    await this.flushSave();
  }

  /** Update the last user message content and regenerate the agent response */
  async updateLastUserMessage(content: MessageContent) {
    await this.interruptStreaming();

    const userIdx = this.messages.findIndex((m) => m.role === "user");
    if (userIdx < 0) return;

    const isEmpty =
      typeof content === "string"
        ? !content.trim()
        : content.every((p) => p.type === "text" && !p.text.trim());
    if (isEmpty) {
      this.messages.splice(0, userIdx + 1);
      await this.flushSave();
      return;
    }

    this.messages[userIdx] = { role: "user", content };

    if (userIdx > 0) {
      this.messages.splice(0, userIdx);
    }

    const isFirstMessage = this.messages.filter((m) => m.role === "user").length === 1;
    if (isFirstMessage) {
      this.sessionTitle = this.getDefaultTitle();
    }

    await this.flushSave();

    const { sendMessages } = await import("$lib/sidecar/llm");
    await sendMessages();
  }
}

export const messagesState = new MessagesState();
