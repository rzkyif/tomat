/**
 * Reactive snapshot of sidecar status, fed by `sidecar.status` WS frames
 * from the currently-selected core. Components read `serversState.serverStatuses`
 * to render running / loading / error / disabled indicators.
 */

import type { ServerToClientFrame, SidecarStatus } from "@tomat/shared";
import { cores } from "$lib/core";

export type ServerStatusUpdate = {
  server: string;
  status: SidecarStatus;
  message?: string;
  progress?: number;
};

const KINDS = ["llama", "whisper", "tts", "tool"] as const;

class ServersState {
  serverStatuses = $state<Record<string, ServerStatusUpdate>>(
    Object.fromEntries(KINDS.map((k) => [k, { server: k, status: "Disabled" as SidecarStatus }])),
  );

  private unsubscribe: (() => void) | null = null;

  /** Wire to the WS hub of the currently-selected core. Idempotent. */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = cores().subscribeWs((frame: ServerToClientFrame) => {
      if (frame.kind !== "sidecar.status") return;
      this.serverStatuses[frame.sidecar] = {
        server: frame.sidecar,
        status: frame.status,
        message: frame.message,
        progress: frame.progress,
      };
    });
  }

  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Backwards-compatible mutator for any code still pushing into the store directly. */
  updateStatus(update: ServerStatusUpdate): void {
    this.serverStatuses[update.server] = update;
  }
}

export const serversState = new ServersState();
