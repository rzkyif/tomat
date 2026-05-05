/**
 * Session metadata, the session list, and cross-slice orchestration of
 * session boundaries (load / create / delete / navigate). Owns the active
 * session id, its display title, the index pointing into the session list,
 * and the epoch counter; coordinates with messagesState, streamingState,
 * persistenceState, and tts on every transition so a session boundary
 * leaves no stale buffers, timers, or playback behind.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ChatHistoryPayload, Message, SessionInfo } from "$lib/shared/types";
import { messagesState } from "./messages.svelte";
import { persistenceState } from "./persistence.svelte";
import { settingsState } from "./settings.svelte";
import { streamingState } from "./streaming.svelte";

/** Defensive snapshot fixups applied on disk → memory load. Tool-call bubbles
 *  and tool_filter bubbles can be persisted in non-terminal states (the app
 *  closed mid-call); freeze them to a clear error so reload doesn't show a
 *  stuck spinner. The matching outbound defense lives in
 *  `persistenceState.sanitizeSnapshotForSave`. */
function backfillMessageIds(messages: Message[]): Message[] {
  let counter = 0;
  for (const m of messages) {
    if (!m.id) m.id = `load-${Date.now()}-${counter++}`;
    if (
      m.role === "tool" &&
      m.toolCall &&
      m.toolCall.status !== "complete" &&
      m.toolCall.status !== "failed" &&
      m.toolCall.status !== "cancelled"
    ) {
      m.toolCall = {
        ...m.toolCall,
        status: "failed",
        error:
          m.toolCall.error ??
          "Tool server was stopped before this tool call completed (the app was closed).",
      };
    }
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

class SessionsState {
  list = $state<SessionInfo[]>([]);
  id = $state<string | null>(null);
  title = $state<string>("");
  currentIndex = $state<number>(-1);
  /** Bumps on every session-boundary transition (new / load / delete /
   *  loadLatest). Consumers use it as a `{#key}` to force a clean DOM
   *  teardown of the message subtree, sidestepping any stale state held
   *  across transitions in stack-group / expansion / tool-call effects. */
  epoch = $state(0);

  get storageEnabled(): boolean {
    return settingsState.currentSettings["general.session.storeSessions"] !== false;
  }

  /** Get the default title (formatted timestamp from the active session id). */
  get defaultTitle(): string {
    if (!this.id) return "";
    const ts = parseInt(this.id, 10);
    if (isNaN(ts)) return this.id;
    const d = new Date(ts);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async loadList() {
    if (!this.storageEnabled) {
      this.list = [];
      return;
    }
    try {
      const sessions = (await invoke("list_chat_sessions")) as SessionInfo[];
      this.list = sessions;
      if (this.id) {
        this.currentIndex = sessions.findIndex((s) => s.id === this.id);
      }
    } catch (e) {
      console.error("Failed to load session list:", e);
    }
  }

  async updateTitle(title: string) {
    this.title = title;
    if (this.id && this.storageEnabled) {
      try {
        await invoke("save_session_title", {
          sessionId: this.id,
          title,
        });
        const idx = this.list.findIndex((s) => s.id === this.id);
        if (idx >= 0) {
          this.list[idx] = { ...this.list[idx], title };
        }
      } catch (e) {
        console.error("Failed to save session title:", e);
      }
    }
  }

  /** Reset every in-memory field that's tied to a single session. Each slice
   *  clears its own per-session fields (this slice owns id/title/epoch);
   *  bumps `epoch` so consumers wrapping the message subtree in
   *  `{#key sessionsState.epoch}` tear down cleanly across the boundary,
   *  regardless of any in-flight effects or transitions that might otherwise
   *  hold stale DOM. */
  private resetAll(): void {
    messagesState.clear();
    streamingState.resetForSession();
    this.id = null;
    this.title = "";
    this.epoch++;
  }

  async loadLatest() {
    if (!this.storageEnabled) return;
    try {
      const history = (await invoke("load_latest_chat_history")) as ChatHistoryPayload | null;
      if (history && Array.isArray(history.messages)) {
        this.resetAll();
        messagesState.hydrate(backfillMessageIds(history.messages), history.contextUsage || null);
        this.id = history.sessionId;
        this.title = history.title || this.defaultTitle;
      }
    } catch (e) {
      console.error("Failed to load chat history:", e);
    }
    await this.loadList();
  }

  async load(sessionId: string) {
    // Drain any debounced save first - otherwise a pending timer could fire
    // after id/messages are replaced and write the new session's data
    // under the new id, silently dropping unpersisted edits to the prior one.
    if (this.id && this.id !== sessionId) {
      await persistenceState.flushSave();
    }
    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();
    try {
      const history = (await invoke("load_chat_session", {
        sessionId,
      })) as ChatHistoryPayload;
      if (history && Array.isArray(history.messages)) {
        this.resetAll();
        messagesState.hydrate(backfillMessageIds(history.messages), history.contextUsage || null);
        this.id = history.sessionId;
        this.title = history.title || this.defaultTitle;
        this.currentIndex = this.list.findIndex((s) => s.id === sessionId);
      }
    } catch (e) {
      console.error("Failed to load session:", e);
    }
  }

  async navigatePrev() {
    if (this.currentIndex <= 0) return;
    const prevId = this.list[this.currentIndex - 1].id;
    await this.load(prevId);
  }

  async navigateNext() {
    if (this.currentIndex >= this.list.length - 1) return;
    const nextId = this.list[this.currentIndex + 1].id;
    await this.load(nextId);
  }

  async delete() {
    if (!this.id) return;

    const sessionToDelete = this.id;
    const deletedIndex = this.list.findIndex((s) => s.id === sessionToDelete);
    const remaining = this.list.filter((s) => s.id !== sessionToDelete);

    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();

    // Drain any in-flight save before flipping the in-memory state. A save
    // completing after the backend delete would resurrect the session file
    // (and leave the UI pointing at an orphaned id).
    persistenceState.cancelPendingSave();
    await persistenceState.awaitPendingSave();
    // Re-cancel: a late-arriving WS event (e.g. tool_cancelled triggered by
    // interruptStreaming) can call resolveToolCall during the await above,
    // which schedules another save. With id still set at that point it'd
    // queue a 1s timer that fires post-delete and (under the now-fixed
    // auto-id fallback) used to create a phantom new session. Belt + braces.
    persistenceState.cancelPendingSave();

    // Clear in-memory session state *before* invoking the backend delete
    // and any follow-up load(). Otherwise load's preemptive flushSave()
    // sees the stale id + empty messages array and rewrites the deleted
    // session back to disk; subsequent sends also wire up against the
    // phantom id and silently drop the user's next message. `epoch` bumps
    // inside `resetAll` so the message subtree's `{#key}` in the renderer
    // remounts cleanly, dropping any DOM still held by stuck transitions
    // on the cancelled tool's bubble body.
    this.resetAll();

    try {
      await invoke("delete_chat_session", { sessionId: sessionToDelete });
    } catch (e) {
      console.error("Failed to delete session:", e);
    }

    this.list = remaining;

    if (remaining.length === 0) {
      this.currentIndex = 0;
      return;
    }

    // Pick the session that slid into the deleted slot, or the previous one
    // if we deleted the tail. Fall back to the first when the deleted id
    // wasn't in the list (deletedIndex === -1).
    const nextIdx =
      deletedIndex < 0 ? 0 : deletedIndex < remaining.length ? deletedIndex : remaining.length - 1;
    await this.load(remaining[nextIdx].id);
  }

  async create() {
    if (this.id && messagesState.messages.length > 0) {
      await persistenceState.flushSave();
    }
    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();

    this.resetAll();

    await this.loadList();
    this.currentIndex = this.list.length;
  }
}

export const sessionsState = new SessionsState();
