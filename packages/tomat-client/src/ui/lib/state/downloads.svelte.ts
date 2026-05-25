/**
 * Reactive mirror of the core's download queue. Fed by `downloads.snapshot`
 * WS broadcasts; mutations go through the core's REST endpoints.
 *
 * `seen` state is purely client-local now (the core doesn't track read
 * state); the rework spec said no migration crusts so a refresh resets
 * the seen-set.
 */

import type { DownloadEntry, DownloadPlan, ServerToClientFrame } from "@tomat/shared";
import { cores } from "$lib/core";

class DownloadsState {
  items = $state<DownloadEntry[]>([]);
  modalOpen = $state(false);
  flashingIds = $state<Set<string>>(new Set());
  /** Per-id "seen" tracking lives only in the client process. */
  seen = $state<Set<string>>(new Set());

  pendingStartup = $state<DownloadPlan[]>([]);
  pendingStartupGroupBySource = $state<Record<string, string>>({});
  startupModalShown = $state(false);

  active = $derived(this.items.filter((i) => i.status === "Pending" || i.status === "Downloading"));
  completed = $derived(this.items.filter((i) => i.status === "Completed"));
  errored = $derived(this.items.filter((i) => i.status === "Error"));
  cancelled = $derived(this.items.filter((i) => i.status === "Cancelled"));
  badgeCount = $derived(this.active.length);
  hasUnseenCompleted = $derived(this.completed.some((i) => !this.seen.has(i.id)));
  hasAny = $derived(this.items.length > 0);

  pendingStartupRemaining = $derived(
    this.pendingStartup.filter((p) => {
      const item = this.items.find((i) => i.source === p.source);
      return !item || item.status !== "Completed";
    }),
  );
  hasPendingStartup = $derived(this.pendingStartupRemaining.length > 0);

  private unsubscribeWs: (() => void) | null = null;

  attach(): void {
    if (this.unsubscribeWs) return;
    this.unsubscribeWs = cores().subscribeWs((frame: ServerToClientFrame) => {
      if (frame.kind === "downloads.snapshot") {
        this.items = frame.items;
      }
    });
    // Seed with the current snapshot so the badge populates before the first
    // WS broadcast arrives. Skipped when no core is paired yet — cores().api()
    // throws in that case, and the snapshot frame will populate items anyway.
    if (cores().currentEntry()) {
      void cores()
        .api()
        .models.downloads()
        .then((items) => {
          this.items = items;
        })
        .catch((e) => {
          console.warn("[downloads] initial snapshot fetch failed:", e);
        });
    }
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
      console.warn("[downloads] cancel failed:", e);
    }
  }

  async retry(id: string): Promise<void> {
    try {
      await cores().api().models.retry(id);
    } catch (e) {
      console.warn("[downloads] retry failed:", e);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await cores().api().models.remove(id);
    } catch (e) {
      console.warn("[downloads] remove failed:", e);
    }
  }

  async clearCompleted(): Promise<void> {
    const ids = this.completed.map((c) => c.id);
    for (const id of ids) {
      try {
        await cores().api().models.remove(id);
      } catch (e) {
        console.warn(`[downloads] clearCompleted: remove(${id}) failed:`, e);
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
