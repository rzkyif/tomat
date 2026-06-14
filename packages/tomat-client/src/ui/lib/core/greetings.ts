// Greeting trigger wrapper. The client reports each app start; the core
// decides from the greetings.* settings whether to run one.

import type { CoreClient } from "./client";

export class GreetingsApi {
  constructor(private readonly client: CoreClient) {}

  run(launch: "autostart" | "manual"): Promise<{ ran: boolean; sessionId?: string }> {
    return this.client.post("/api/v1/greetings/run", { launch });
  }
}
