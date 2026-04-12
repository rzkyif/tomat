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

class MessagesState {
  messages = $state<Message[]>([]);
  sessionId = $state<string | null>(null);
  sessionTitle = $state<string>("");
  sessionList = $state<SessionInfo[]>([]);
  currentSessionIndex = $state<number>(-1);
  tokenUsage = $state<TokenUsage | null>(null);
  isStreaming = $state(false);
  streamingFirstChunkReceived = $state(false);

  private get storageEnabled(): boolean {
    return settingsState.currentSettings["behaviour.storeSessions"] !== false;
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
    this.save();
  }

  async loadSessionList() {
    if (!this.storageEnabled) {
      this.sessionList = [];
      return;
    }
    try {
      const sessions = (await invoke("list_chat_sessions")) as SessionInfo[];
      this.sessionList = sessions;
      // Update current index based on sessionId
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
      }
    } catch (e) {
      console.error("Failed to load chat history:", e);
    }
    await this.loadSessionList();
  }

  async loadSession(sessionId: string) {
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

    const deletedIndex = this.currentSessionIndex;

    try {
      await invoke("delete_chat_session", { sessionId: this.sessionId });
    } catch (e) {
      console.error("Failed to delete session:", e);
      return;
    }

    // Reload session list after deletion
    this.sessionList = this.sessionList.filter((_, i) => i !== deletedIndex);

    if (this.sessionList.length === 0) {
      // No sessions left — go to new session mode
      this.messages = [];
      this.sessionId = null;
      this.sessionTitle = "";
      this.tokenUsage = null;
      this.isStreaming = false;
      this.streamingFirstChunkReceived = false;
      this.currentSessionIndex = 0;
    } else if (deletedIndex < this.sessionList.length) {
      // Load the next session (now at the same index)
      await this.loadSession(this.sessionList[deletedIndex].id);
    } else {
      // Deleted the last one — load the previous
      await this.loadSession(this.sessionList[deletedIndex - 1].id);
    }
  }

  async newSession() {
    // Save current session first if exists
    if (this.sessionId && this.messages.length > 0) {
      await this.save();
    }

    this.messages = [];
    this.sessionId = null;
    this.sessionTitle = "";
    this.tokenUsage = null;
    this.isStreaming = false;
    this.streamingFirstChunkReceived = false;

    // Reload the session list so the new (empty) session shows up after first message
    await this.loadSessionList();
    this.currentSessionIndex = this.sessionList.length; // points past end
  }

  async updateTitle(title: string) {
    this.sessionTitle = title;
    if (this.sessionId && this.storageEnabled) {
      try {
        await invoke("save_session_title", {
          sessionId: this.sessionId,
          title,
        });
        // Update list entry too
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
    // Persist token usage with the session
    this.save();
  }

  async save() {
    if (!this.storageEnabled) return;
    try {
      // Eagerly assign sessionId before the first await to prevent concurrent save()
      // calls (e.g. addMessage + startStreaming in the same tick) from each seeing
      // sessionId === null and creating two separate sessions.
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
        // Refresh session list when a new session is created
        await this.loadSessionList();
      }
    } catch (e) {
      console.error("Failed to save chat history:", e);
    }
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
      this.messages[0].content = "";
      this.streamingFirstChunkReceived = true;
    }
    this.messages[0].content += content;
  }

  finishStreaming() {
    this.isStreaming = false;
    this.save();
  }

  receiveErrorMessage(errorType: LLMErrorType, detail?: string) {
    this.isStreaming = false;
    const content = detail ? `${errorType}\n${detail}` : errorType;
    this.messages[0] = { role: "error", content };
    this.save();
  }

  async interruptStreaming(): Promise<void> {
    if (!this.isStreaming) return;

    if (this.streamingFirstChunkReceived) {
      const current = this.messages[0].content;
      if (typeof current === "string") {
        this.messages[0].content = current + "\n\n> _User interrupted._";
      }
    } else {
      this.messages[0].content = "> _User interrupted._";
    }

    this.isStreaming = false;
    this.streamingFirstChunkReceived = false;
    interruptCurrentStream();
    await this.save();
  }

  /** Update the last user message content and regenerate the agent response */
  async updateLastUserMessage(content: MessageContent) {
    await this.interruptStreaming();

    // Find the last user message (messages are in reverse order — newest first)
    const userIdx = this.messages.findIndex((m) => m.role === "user");
    if (userIdx < 0) return;

    // If content is empty, delete the user message and its response
    const isEmpty =
      typeof content === "string"
        ? !content.trim()
        : content.length === 0 || content.every((p) => p.type === "text" && !p.text.trim());
    if (isEmpty) {
      // Remove everything from the user message and all newer messages (the response)
      this.messages.splice(0, userIdx + 1);
      await this.save();
      return;
    }

    this.messages[userIdx] = { role: "user", content };

    // Remove the agent response that followed it (it's at index userIdx - 1 if it exists)
    if (userIdx > 0) {
      this.messages.splice(0, userIdx);
    }

    // If this is the first user message, reset the title so it gets regenerated
    const isFirstMessage = this.messages.filter((m) => m.role === "user").length === 1;
    if (isFirstMessage) {
      this.sessionTitle = this.getDefaultTitle();
    }

    await this.save();

    // Regenerate
    const { sendMessages } = await import("$lib/sidecar/llm");
    await sendMessages();
  }
}

export const messagesState = new MessagesState();
