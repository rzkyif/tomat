/**
 * Reactive WebSocket connection state for the currently-selected core, driving
 * the adaptive reconnecting UI (chat input, settings lock-down, quick-settings
 * redirect). Hides flashes of disconnection that resolve within
 * RECONNECT_BANNER_DELAY_MS. The underlying CoreClient already retries with exp
 * backoff (500 ms → 30 s), so a brief reconnect during normal operation
 * shouldn't be visible.
 */

import type { ConnectionState } from "$lib/core/client";
import { cores } from "$lib/core";
import { Subscriptions } from "$lib/util/subscriptions";

const RECONNECT_BANNER_DELAY_MS = 5_000;

class ConnectionStateStore {
  state = $state<ConnectionState>("connecting");
  disconnectedSinceMs = $state<number | null>(null);

  // True once disconnected for at least RECONNECT_BANNER_DELAY_MS. Kept
  // as plain state (not $derived) so we can manage the delay timer. Drives the
  // adaptive reconnecting UI across chat / settings / quick-settings modes.
  reconnecting = $state(false);

  // True when the core rejected our bearer token (its DB was reset, this
  // client was revoked, ...). Terminal: the underlying client stops retrying,
  // so the UI shows a re-pair prompt rather than a "reconnecting" spinner.
  unauthorized = $state(false);

  // Last connect-failure reason from CoreClient (e.g. "Connection refused"),
  // shown in the banner. Retained across the connecting/disconnected churn of
  // the reconnect loop; cleared once connected.
  reason = $state<string | null>(null);

  private subs = new Subscriptions();
  // ReturnType so the type works under both browser (number) and node typing.
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;

  attach(): void {
    this.subs.attach(() => [
      cores().subscribeConnectionState((s, r) => {
        this.state = s;
        if (s === "connected") {
          this.disconnectedSinceMs = null;
          this.clearBannerTimer();
          this.reconnecting = false;
          this.unauthorized = false;
          this.reason = null;
        } else if (s === "unauthorized") {
          // Terminal: the client has stopped retrying. Drop the reconnect spinner
          // and show the re-pair prompt; keep the reason for the message.
          this.clearBannerTimer();
          this.reconnecting = false;
          this.unauthorized = true;
          if (r) this.reason = r;
        } else if (s === "disconnected" || s === "connecting") {
          // Keep the last known reason through the connecting/disconnected churn.
          if (r) this.reason = r;
          if (this.disconnectedSinceMs === null) {
            this.disconnectedSinceMs = Date.now();
          }
          if (!this.reconnecting && this.bannerTimer === null) {
            this.bannerTimer = setTimeout(() => {
              this.bannerTimer = null;
              // Re-check at fire time: a quick reconnect may have already
              // flipped state back.
              if (this.state !== "connected") this.reconnecting = true;
            }, RECONNECT_BANNER_DELAY_MS);
          }
        }
      }),
    ]);
  }

  detach(): void {
    this.subs.detach();
    this.clearBannerTimer();
    this.state = "connecting";
    this.disconnectedSinceMs = null;
    this.reconnecting = false;
    this.unauthorized = false;
    this.reason = null;
  }

  private clearBannerTimer(): void {
    if (this.bannerTimer !== null) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
  }
}

export const connectionState = new ConnectionStateStore();
