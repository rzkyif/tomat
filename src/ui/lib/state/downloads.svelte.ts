/**
 * Reactive mirror of the Rust DownloadManager queue. Listens to the
 * `download-queue` event channel to track every queued / active /
 * completed / errored download in a single store, drives the
 * DownloadsButton badge + DownloadsModal contents.
 */

import { invoke } from "@tauri-apps/api/core";
import type { DownloadItem } from "$lib/shared/types";
import type { DownloadPlan } from "$lib/shared/download";

class DownloadsState {
  items = $state<DownloadItem[]>([]);
  modalOpen = $state(false);
  // Set on modal open; cleared 2s later. Drives the green-flash bg for
  // completed-but-unseen items so each is celebrated exactly once.
  flashingIds = $state<Set<string>>(new Set());

  // Snapshot taken at app startup of every required HF file that wasn't
  // on disk yet. Drives the input-disable + gear-blink + auto-shown
  // ConfirmModal UX. Cleared as items finish downloading.
  pendingStartup = $state<DownloadPlan[]>([]);
  pendingStartupGroupBySource = $state<Record<string, string>>({});
  // Flips to true once the startup ConfirmModal has been auto-shown so
  // we don't re-prompt the user every time they reopen Settings.
  startupModalShown = $state(false);

  active = $derived(this.items.filter((i) => i.status === "Pending" || i.status === "Downloading"));
  completed = $derived(this.items.filter((i) => i.status === "Completed"));
  errored = $derived(this.items.filter((i) => i.status === "Error"));
  cancelled = $derived(this.items.filter((i) => i.status === "Cancelled"));
  badgeCount = $derived(this.active.length);
  // True when nothing is active/queued but at least one Completed item
  // hasn't been acknowledged yet (i.e. user hasn't opened the modal
  // since it finished). Drives the idle "downloads finished" badge.
  hasUnseenCompleted = $derived(this.completed.some((i) => !i.seen));
  hasAny = $derived(this.items.length > 0);

  // A startup-required file is "still pending" until the manager has a
  // matching item in `Completed` state. Errored / cancelled / in-flight
  // all count as pending so the input stays gated. The Rust side drops
  // any persisted Completed row whose file vanished on the next
  // launch, so this filter never sees stale entries.
  pendingStartupRemaining = $derived(
    this.pendingStartup.filter((p) => {
      const item = this.items.find((i) => i.source === p.path);
      return !item || item.status !== "Completed";
    }),
  );
  hasPendingStartup = $derived(this.pendingStartupRemaining.length > 0);

  async openModal() {
    const unseen = this.items.filter((i) => i.status === "Completed" && !i.seen).map((i) => i.id);
    this.flashingIds = new Set(unseen);
    this.modalOpen = true;
    try {
      await invoke("mark_downloads_seen");
    } catch (e) {
      console.warn("[downloads] mark_downloads_seen failed:", e);
    }
    setTimeout(() => {
      this.flashingIds = new Set();
    }, 2000);
  }

  closeModal() {
    this.modalOpen = false;
  }

  async cancel(id: string) {
    try {
      await invoke("cancel_download", { id });
    } catch (e) {
      console.warn("[downloads] cancel failed:", e);
    }
  }

  async retry(id: string) {
    try {
      await invoke("retry_download", { id });
    } catch (e) {
      console.warn("[downloads] retry failed:", e);
    }
  }

  async remove(id: string) {
    try {
      await invoke("remove_download", { id });
    } catch (e) {
      console.warn("[downloads] remove failed:", e);
    }
  }

  async clearCompleted() {
    try {
      await invoke("clear_completed_downloads");
    } catch (e) {
      console.warn("[downloads] clear_completed failed:", e);
    }
  }

  async reveal(absPath: string) {
    try {
      await invoke("reveal_tomat_path", { path: absPath });
    } catch (e) {
      console.warn("[downloads] reveal failed:", e);
    }
  }
}

export const downloadsState = new DownloadsState();
