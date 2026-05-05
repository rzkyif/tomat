/**
 * Debounced session-history persistence. Coalesces rapid mutations (typing,
 * streaming, tool progress) into a single trailing save, drains pending
 * timers before session boundaries, hooks `beforeunload` so an app close
 * mid-stream still flushes the in-memory transcript, and prunes attachment
 * files dropped by user-message edits. Pure side-effect layer: reads from
 * messagesState, sessionsState, and streamingState (the latter to filter
 * out the mid-stream assistant bubble from outbound snapshots), writes
 * via the Tauri command.
 */

import { invoke } from "@tauri-apps/api/core";
import { deleteSessionAttachments, diffRemovedAttachmentPaths } from "$lib/shared/attachments";
import type { Message, MessageContent } from "$lib/shared/types";
import { messagesState } from "./messages.svelte";
import { sessionsState } from "./sessions.svelte";
import { streamingState } from "./streaming.svelte";

/** Trailing-edge debounce for `save`. At 1s, rapid edits (user typing + tool
 *  streaming) coalesce into one write instead of fanning out dozens of
 *  tmp-file renames per second. */
const SAVE_DEBOUNCE_MS = 1000;

class PersistenceState {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight: Promise<void> = Promise.resolve();
  private unloadHooked = false;

  /** Debounced trailing-edge save. Prevents write amplification on hot paths
   *  (per-message adds, per-token usage updates). No-op when no session is
   *  active: a late WS callback (e.g. resolveToolCall from a tool_cancelled
   *  reply that lands after deleteSession cleared state) calls scheduleSave
   *  on cleared state, and we don't want that to queue a write under a null
   *  sessionId (the legitimate first-save path pre-assigns sessionId in
   *  addUserMessage). */
  scheduleSave(): void {
    if (!sessionsState.storageEnabled) return;
    if (!sessionsState.id) return;
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
  cancelPendingSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** Block until any in-flight save serializes its current chained step.
   *  Used by the delete path so a late save can't resurrect a file just
   *  removed. Does NOT cancel pending timers - call `cancelPendingSave`
   *  first when the goal is to drop, not drain. */
  async awaitPendingSave(): Promise<void> {
    await this.saveInFlight;
  }

  /** Diff `prev` against `next` and fire-and-forget delete the session
   *  attachment files that are no longer referenced. Used by user-message
   *  edits and deletes so an attachment removed from the message also gets
   *  removed from disk. Pass `""` for `next` when the entire message is
   *  going away. Errors from the backend delete are intentionally swallowed
   *  (already-deleted files are not a problem worth surfacing). */
  cleanupRemovedAttachments(prev: MessageContent, next: MessageContent | ""): void {
    const removedPaths = diffRemovedAttachmentPaths(prev, next);
    if (removedPaths.length > 0) {
      void deleteSessionAttachments(removedPaths);
    }
  }

  private hookUnloadFlush(): void {
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
    const snapshot = $state.snapshot(messagesState.messages) as Message[];
    const streamingId = streamingState.messageId;
    const out: Message[] = [];
    for (const m of snapshot) {
      // Drop the assistant message currently mid-stream; it'll be persisted
      // on the next flushSave after finishStreaming. Keeping it here would
      // save half-written content that we can never resume.
      if (streamingState.isActive && streamingId !== null && m.id === streamingId) {
        continue;
      }
      // Tool calls in non-terminal status: rewrite to a failed snapshot so
      // reload doesn't show a stuck spinner, and the user sees a clear
      // error explaining the tool server is gone.
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
            status: "failed",
            error:
              m.toolCall.error ??
              "Tool server was stopped before this tool call completed (the app was closed).",
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

  async save(): Promise<void> {
    if (!sessionsState.storageEnabled) return;
    // No active session = nothing to save. Used to auto-generate a fresh
    // sessionId here as a fallback, but that path could resurrect/create
    // phantom sessions when a late WS callback (post-delete) invoked save
    // through scheduleSave. addUserMessage pre-assigns sessionId for the
    // legitimate first-save path, so this is purely a guard now.
    if (!sessionsState.id) return;
    // Chain saves so rapid successive calls still serialize in order. The
    // trailing .catch() ensures a single unexpected rejection (e.g. a throw
    // outside the inner try/catch) doesn't wedge every subsequent save
    // behind a permanently rejected promise.
    this.saveInFlight = this.saveInFlight
      .then(async () => {
        try {
          // Re-check the guard inside the chained continuation: a session
          // can be cleared between the initial call and when this body runs
          // (the previous save in the chain awaits invoke), and we don't
          // want to write under a null id.
          if (!sessionsState.id) return;
          const isNew = !sessionsState.list.some((s) => s.id === sessionsState.id);

          await invoke("save_chat_history", {
            messages: this.sanitizeSnapshotForSave(),
            sessionId: sessionsState.id,
            title: sessionsState.title || null,
            contextUsage: messagesState.tokenUsage
              ? $state.snapshot(messagesState.tokenUsage)
              : null,
          });

          if (isNew) {
            await sessionsState.loadList();
          }
        } catch (e) {
          console.error("Failed to save chat history:", e);
        }
      })
      .catch((e) => {
        console.error("[persistence] save chain error:", e);
      });
    await this.saveInFlight;
  }
}

export const persistenceState = new PersistenceState();
