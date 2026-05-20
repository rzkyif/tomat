/**
 * Reactive snapshot of the latest status reported by each sidecar process.
 * The sidecar manager writes to this as backend events arrive, and
 * components read from it to render running / loading / error indicators.
 */

import type { ServerStatusUpdate } from "$lib/shared/types";

class ServersState {
  serverStatuses = $state<Record<string, ServerStatusUpdate>>({
    llm: { server: "llm", status: "Disabled" },
    stt: { server: "stt", status: "Disabled" },
    bun: { server: "bun", status: "Disabled" },
  });

  updateStatus(update: ServerStatusUpdate) {
    this.serverStatuses[update.server] = update;
  }
}

export const serversState = new ServersState();
