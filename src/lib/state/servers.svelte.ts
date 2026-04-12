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
