/**
 * Reactive WebSocket connection state for the currently-selected core,
 * driving the "Reconnecting to <core>…" banner. Hides flashes of
 * disconnection that resolve within RECONNECT_BANNER_DELAY_MS — the
 * underlying CoreClient already retries with exp backoff (500 ms → 30 s),
 * so a brief reconnect during normal operation shouldn't be visible.
 */

import type { ConnectionState } from "$lib/core/client";
import { cores } from "$lib/core";

const RECONNECT_BANNER_DELAY_MS = 5_000;

class ConnectionStateStore {
  state = $state<ConnectionState>("connecting");
  disconnectedSinceMs = $state<number | null>(null);

  // True once disconnected for at least RECONNECT_BANNER_DELAY_MS. Kept
  // as plain state (not $derived) so we can manage the delay timer.
  showReconnectBanner = $state(false);

  private unsubscribe: (() => void) | null = null;
  // ReturnType so the type works under both browser (number) and node typing.
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;

  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = cores().subscribeConnectionState((s) => {
      this.state = s;
      if (s === "connected") {
        this.disconnectedSinceMs = null;
        this.clearBannerTimer();
        this.showReconnectBanner = false;
      } else if (s === "disconnected" || s === "connecting") {
        if (this.disconnectedSinceMs === null) {
          this.disconnectedSinceMs = Date.now();
        }
        if (!this.showReconnectBanner && this.bannerTimer === null) {
          this.bannerTimer = setTimeout(() => {
            this.bannerTimer = null;
            // Re-check at fire time: a quick reconnect may have already
            // flipped state back.
            if (this.state !== "connected") this.showReconnectBanner = true;
          }, RECONNECT_BANNER_DELAY_MS);
        }
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearBannerTimer();
    this.state = "connecting";
    this.disconnectedSinceMs = null;
    this.showReconnectBanner = false;
  }

  private clearBannerTimer(): void {
    if (this.bannerTimer !== null) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
  }
}

export const connectionState = new ConnectionStateStore();
