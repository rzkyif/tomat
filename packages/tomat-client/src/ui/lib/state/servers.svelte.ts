/**
 * Reactive snapshot of sidecar status, fed by `sidecar.status` WS frames
 * from the currently-selected core. Components read `serversState.serverStatuses`
 * to render running / loading / error / disabled indicators.
 */

import type { ServerToClientFrame, SidecarKind, SidecarStatus } from "@tomat/shared";
import { cores } from "$lib/core";

export type ServerStatusUpdate = {
  server: SidecarKind;
  status: SidecarStatus;
  message?: string;
  progress?: number;
};

class ServersState {
  // Seeded with every sidecar kind so a render that reads a status (e.g. the
  // chat input's STT chip) never hits an undefined entry before the first WS
  // frame arrives. Keyed by SidecarKind so a stale key (the old "whisper" /
  // "tts") is a compile error here rather than a runtime crash.
  serverStatuses = $state<Record<SidecarKind, ServerStatusUpdate>>({
    llama: { server: "llama", status: "Disabled" },
    "llama-embed": { server: "llama-embed", status: "Disabled" },
    speech: { server: "speech", status: "Disabled" },
    tool: { server: "tool", status: "Disabled" },
  });

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
