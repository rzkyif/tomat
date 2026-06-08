/**
 * Session metadata, list, and cross-slice orchestration. Owns the active
 * session id, its display title, the list index, and an epoch counter that
 * lets components remount cleanly on session boundaries.
 *
 * All session persistence is now server-side: list/load/save/delete go
 * through cores().api().sessions. Title generation runs server-side too;
 * the client just receives `session.updated` frames.
 */

import type {
  Message as ServerMessage,
  ServerToClientFrame,
  SessionListEntry,
} from "@tomat/shared";
import type { Message } from "$lib/shared/types";
import { cores } from "$lib/core";
import { getLogger } from "$lib/shared/log";
import { messagesState } from "./messages.svelte";
import { settingsState } from "./settings.svelte";
import { streamingState } from "./streaming.svelte";

const log = getLogger("sessions");

export type SessionInfo = SessionListEntry;

/** Defensive snapshot fixups applied on disk → memory load. The server's
 *  Message shape and the client's are similar but not identical; cast
 *  through unknown at the boundary. */
function backfillMessageIds(messages: ServerMessage[]): Message[] {
  let counter = 0;
  const out = messages as unknown as Message[];
  for (const m of out) {
    if (!m.id) m.id = `load-${Date.now()}-${counter++}`;
    if (
      m.toolCall &&
      m.toolCall.status !== "complete" &&
      m.toolCall.status !== "failed" &&
      m.toolCall.status !== "cancelled"
    ) {
      m.toolCall = {
        ...m.toolCall,
        status: "failed",
        error: m.toolCall.error ?? "interrupted: core was disconnected mid-call",
      };
    }
    if (m.relevantTools && m.relevantTools.status === "filtering") {
      m.relevantTools = {
        ...m.relevantTools,
        status: "error",
        errorMessage: m.relevantTools.errorMessage ?? "interrupted: session was reloaded",
      };
    }
  }
  return out;
}

class SessionsState {
  list = $state<SessionInfo[]>([]);
  id = $state<string | null>(null);
  title = $state<string>("");
  currentIndex = $state<number>(-1);
  /** Bumps on every session-boundary transition. Consumers use it as a
   *  `{#key}` to force a clean DOM teardown of the message subtree. */
  epoch = $state(0);

  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeConn: (() => void) | null = null;
  // Reconnect-resync bookkeeping: only reload after a real gap (a drop following
  // a prior connect), never on the very first connect of the session.
  private hasConnected = false;
  private droppedSinceConnected = false;

  get storageEnabled(): boolean {
    // Sessions are server-owned now; the toggle remains as a client-side
    // hint for "don't auto-persist this turn", but the default is true.
    return settingsState.currentSettings["general.session.storeSessions"] !== false;
  }

  get defaultTitle(): string {
    if (!this.id) return "";
    // Server now mints ULIDs (not timestamps); fall back to id-as-label.
    return this.id;
  }

  /** Wire up to session.updated frames so title changes / server-side
   *  message persistence reach the UI without polling. */
  attach(): void {
    if (this.unsubscribeWs) return;
    this.unsubscribeWs = cores().subscribeWs((frame: ServerToClientFrame) => {
      if (frame.kind !== "session.updated") return;
      if (frame.sessionId !== this.id) return;
      if (frame.op === "title_changed" && frame.payload?.title !== undefined) {
        this.title = frame.payload.title;
        const idx = this.list.findIndex((s) => s.id === this.id);
        if (idx >= 0) this.list[idx] = { ...this.list[idx], title: frame.payload.title };
      } else if (frame.op === "message_added" && frame.payload?.message) {
        messagesState.upsertFromServer(frame.payload.message as ServerMessage);
      } else if (frame.op === "message_updated" && frame.payload?.message) {
        messagesState.upsertFromServer(frame.payload.message as ServerMessage);
      } else if (frame.op === "message_deleted" && frame.payload?.messageId) {
        messagesState.removeById(frame.payload.messageId);
      }
    });
    // During a disconnect gap the session.updated/message_added frames above are
    // lost, so server-side changes (e.g. a finished turn) are missed. Reload the
    // active session on reconnect to resync; load() also re-runs the in-flight
    // fixups in backfillMessageIds. Only after a real gap, never on first connect.
    this.unsubscribeConn = cores().subscribeConnectionState((state) => {
      if (state === "connected") {
        if (this.droppedSinceConnected && this.id) {
          log.info("reconnected; reloading active session");
          void this.load(this.id);
        }
        this.hasConnected = true;
        this.droppedSinceConnected = false;
      } else if (this.hasConnected) {
        // Disconnected/connecting after a prior connect: a real gap to resync.
        this.droppedSinceConnected = true;
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
    this.hasConnected = false;
    this.droppedSinceConnected = false;
  }

  async loadList(): Promise<void> {
    if (!this.storageEnabled) {
      this.list = [];
      return;
    }
    try {
      this.list = await cores().api().sessions.list();
      if (this.id) {
        this.currentIndex = this.list.findIndex((s) => s.id === this.id);
      }
    } catch (e) {
      log.error("Failed to load session list:", e);
    }
  }

  async updateTitle(title: string): Promise<void> {
    this.title = title;
    if (!this.id || !this.storageEnabled) return;
    try {
      await cores().api().sessions.patchTitle(this.id, title);
      const idx = this.list.findIndex((s) => s.id === this.id);
      if (idx >= 0) this.list[idx] = { ...this.list[idx], title };
    } catch (e) {
      log.error("Failed to save session title:", e);
    }
  }

  /** Reset every in-memory field that's tied to a single session. */
  private resetAll(): void {
    messagesState.clear();
    streamingState.resetForSession();
    this.id = null;
    this.title = "";
    this.epoch++;
  }

  async loadLatest(): Promise<void> {
    if (!this.storageEnabled) return;
    try {
      await this.loadList();
      if (this.list.length === 0) return;
      const first = this.list[0];
      await this.load(first.id);
    } catch (e) {
      log.error("Failed to load latest:", e);
    }
  }

  async load(sessionId: string): Promise<void> {
    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();
    try {
      const full = await cores().api().sessions.get(sessionId);
      this.resetAll();
      messagesState.hydrate(backfillMessageIds(full.messages), full.tokenUsage ?? null);
      this.id = full.id;
      this.title = full.title || this.defaultTitle;
      this.currentIndex = this.list.findIndex((s) => s.id === sessionId);
    } catch (e) {
      log.error("Failed to load session:", e);
    }
  }

  /** Delete an arbitrary session by id. When it's the active session this
   *  delegates to delete() (session-boundary reset + navigation to a
   *  neighbour); otherwise it just drops the row from the list in place. */
  async deleteById(id: string): Promise<void> {
    if (id === this.id) {
      await this.delete();
      return;
    }
    try {
      await cores().api().sessions.delete(id);
    } catch (e) {
      log.error("Failed to delete session:", e);
      return;
    }
    this.list = this.list.filter((s) => s.id !== id);
    if (this.id) {
      this.currentIndex = this.list.findIndex((s) => s.id === this.id);
    }
  }

  async delete(): Promise<void> {
    if (!this.id) return;
    const sessionToDelete = this.id;
    const deletedIndex = this.list.findIndex((s) => s.id === sessionToDelete);
    const remaining = this.list.filter((s) => s.id !== sessionToDelete);

    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();
    this.resetAll();

    try {
      await cores().api().sessions.delete(sessionToDelete);
    } catch (e) {
      log.error("Failed to delete session:", e);
    }
    this.list = remaining;

    if (remaining.length === 0) {
      this.currentIndex = 0;
      return;
    }
    const nextIdx =
      deletedIndex < 0 ? 0 : deletedIndex < remaining.length ? deletedIndex : remaining.length - 1;
    await this.load(remaining[nextIdx].id);
  }

  async create(): Promise<void> {
    await streamingState.interruptStreaming();
    streamingState.resetTTSPlayback();
    try {
      const session = await cores().api().sessions.create();
      this.resetAll();
      this.id = session.id;
      this.title = session.title || this.defaultTitle;
      await this.loadList();
      this.currentIndex = this.list.findIndex((s) => s.id === session.id);
    } catch (e) {
      log.error("Failed to create session:", e);
    }
  }
}

export const sessionsState = new SessionsState();
