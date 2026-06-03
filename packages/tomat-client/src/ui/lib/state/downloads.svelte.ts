/**
 * Reactive mirror of the core's download queue. Fed by `downloads.snapshot`
 * WS broadcasts; mutations go through the core's REST endpoints.
 *
 * `seen` state is purely client-local now (the core doesn't track read
 * state); the rework spec said no migration crusts so a refresh resets
 * the seen-set.
 */

import type { DownloadEntry, RequiredFile, ServerToClientFrame } from "@tomat/shared";
import { cores } from "$lib/core";
import { getLogger } from "$lib/shared/log";
import { confirmState } from "./confirm.svelte";

const log = getLogger("downloads");
const reqLog = getLogger("requirements");

class DownloadsState {
  items = $state<DownloadEntry[]>([]);
  modalOpen = $state(false);
  flashingIds = $state<Set<string>>(new Set());
  /** Per-id "seen" tracking lives only in the client process. */
  seen = $state<Set<string>>(new Set());

  // Authoritative required-files snapshot from the core (one source of truth).
  // `missing` is what the pending-downloads popup renders and the app gates on.
  required = $state<RequiredFile[]>([]);
  missing = $state<RequiredFile[]>([]);
  // False until the first authoritative requirements snapshot lands (WS frame
  // or HTTP fetch) for the current core. The UI gates on `loading` so boot and
  // core-switch show a loading state instead of defaulting to "ready" and then
  // flipping to "pending" once a snapshot reveals missing files.
  requirementsLoaded = $state(false);

  active = $derived(this.items.filter((i) => i.status === "Pending" || i.status === "Downloading"));
  completed = $derived(this.items.filter((i) => i.status === "Completed"));
  errored = $derived(this.items.filter((i) => i.status === "Error"));
  cancelled = $derived(this.items.filter((i) => i.status === "Cancelled"));
  hasAny = $derived(this.items.length > 0);

  hasPending = $derived(this.missing.length > 0);
  /** True until the first requirements snapshot arrives for the current core:
   *  callers show a loading state rather than assuming "ready". */
  loading = $derived(!this.requirementsLoaded);
  /** Order-independent signature of the missing set, for the "Do It Later"
   *  dismissal logic: the popup re-shows when this changes. */
  missingSignature = $derived(
    this.missing
      .map((m) => m.source)
      .sort()
      .join("|"),
  );

  private unsubscribeWs: (() => void) | null = null;

  attach(): void {
    if (this.unsubscribeWs) return;
    this.unsubscribeWs = cores().subscribeWs((frame: ServerToClientFrame) => {
      if (frame.kind === "downloads.snapshot") {
        this.items = frame.items;
      } else if (frame.kind === "requirements.snapshot") {
        this.required = frame.required;
        this.missing = frame.missing;
        this.requirementsLoaded = true;
      }
    });
    // Seed before the first WS broadcast arrives. Skipped when no core is
    // paired yet (cores().api() throws); the WS frames populate everything
    // once a core is selected.
    if (cores().currentEntry()) {
      void cores()
        .api()
        .models.downloads()
        .then((items) => {
          this.items = items;
        })
        .catch((e) => {
          log.warn("initial snapshot fetch failed:", e);
        });
      void this.refetchRequirements();
    }
  }

  /** Pull the requirements snapshot over HTTP. Load-bearing at startup (the
   *  WS snapshot may be broadcast before this client's socket connects) and on
   *  core switch. */
  async refetchRequirements(): Promise<void> {
    if (!cores().currentEntry()) return;
    // Re-enter the loading state until the snapshot lands so a core switch
    // can't briefly show the previous core's (or a default "ready") state.
    this.requirementsLoaded = false;
    try {
      const snap = await cores().api().requirements.get();
      this.required = snap.required;
      this.missing = snap.missing;
      this.requirementsLoaded = true;
    } catch (e) {
      reqLog.warn("initial fetch failed:", e);
    }
  }

  /** Build + fire the "Pending Downloads" confirm modal from the current
   *  `missing` set. `hooks` lets the Settings auto-popup layer its dismissal
   *  bookkeeping on top; the sidebar button calls it with no hooks to force a
   *  re-show while pending. */
  requestRequiredModal(hooks?: { onConfirm?: () => void; onCancel?: () => void }): void {
    const plans = this.missing.map((m) => ({
      source: m.source,
      alreadyHave: false,
      sizeHint: m.sizeHint,
      version: m.version,
    }));
    confirmState.request({
      title: "Pending Downloads",
      message:
        `The following file${plans.length === 1 ? "" : "s"} need${plans.length === 1 ? "s" : ""} to be downloaded ` +
        `so the core can run with the current configuration.`,
      confirmLabel: "Download",
      cancelLabel: "Do It Later",
      downloads: plans,
      onConfirm: async () => {
        hooks?.onConfirm?.();
        try {
          await cores().api().requirements.download();
        } catch (e) {
          reqLog.warn("download failed:", e);
        }
      },
      onCancel: () => hooks?.onCancel?.(),
    });
  }

  detach(): void {
    if (this.unsubscribeWs) {
      this.unsubscribeWs();
      this.unsubscribeWs = null;
    }
  }

  openModal(): void {
    const unseen = this.items
      .filter((i) => i.status === "Completed" && !this.seen.has(i.id))
      .map((i) => i.id);
    this.flashingIds = new Set(unseen);
    this.modalOpen = true;
    for (const id of this.items.map((i) => i.id)) this.seen.add(id);
    setTimeout(() => {
      this.flashingIds = new Set();
    }, 2000);
  }

  closeModal(): void {
    this.modalOpen = false;
  }

  async cancel(id: string): Promise<void> {
    try {
      await cores().api().models.cancel(id);
    } catch (e) {
      log.warn("cancel failed:", e);
    }
  }

  async retry(id: string): Promise<void> {
    try {
      await cores().api().models.retry(id);
    } catch (e) {
      log.warn("retry failed:", e);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await cores().api().models.remove(id);
    } catch (e) {
      log.warn("remove failed:", e);
    }
  }

  async clearCompleted(): Promise<void> {
    const ids = this.completed.map((c) => c.id);
    for (const id of ids) {
      try {
        await cores().api().models.remove(id);
      } catch (e) {
        log.warn(`clearCompleted: remove(${id}) failed:`, e);
      }
    }
  }

  reveal(_absPath: string): void {
    // Reveal-on-disk only meaningful for the local same-PC core. For a
    // remote core we have nothing useful to do. Punted until the
    // platform abstraction grows a reveal verb.
  }
}

export const downloadsState = new DownloadsState();
