/**
 * Reactive store for configured MCP servers and their prompts/resources. The
 * core owns the connections; this mirrors the projected state for the MCP
 * settings manager, the Tools manager (MCP tools), and the "/" + "@"
 * autocomplete. Refreshed on connect and on every `mcp.snapshot` frame.
 */

import {
  errMessage,
  type McpPrompt,
  type McpResource,
  type McpServer,
  type ServerToClientFrame,
} from "@tomat/shared";
import { cores } from "$lib/core/cores";
import type { McpServerInput } from "$lib/core/mcp";
import { platform } from "$lib/platform";
import { getLogger } from "$lib/util/log";
import { Subscriptions } from "$lib/util/subscriptions";

const log = getLogger("mcp");

class McpState {
  servers = $state<McpServer[]>([]);
  prompts = $state<McpPrompt[]>([]);
  resources = $state<McpResource[]>([]);
  wsConnected = $state(false);
  // Reason the last refresh failed, surfaced as the manager's empty/error state.
  // Null once a refresh succeeds.
  loadError = $state<string | null>(null);
  // Server ids with a reconnect/delete call in flight, so the card can show a
  // spinner and disable the menu row while it runs.
  busy = $state<Record<string, boolean>>({});

  private subs = new Subscriptions();

  attach(): void {
    this.subs.attach(() => [
      cores().subscribeWs((f) => this.onFrame(f)),
      cores().subscribeConnectionState((state) => {
        this.wsConnected = state === "connected";
        if (state === "connected") void this.refresh();
      }),
    ]);
  }

  detach(): void {
    this.subs.detach();
  }

  private onFrame(frame: ServerToClientFrame): void {
    if (frame.kind === "mcp.snapshot") void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const [servers, prompts, resources] = await Promise.all([
        cores().api().mcp.list(),
        cores().api().mcp.listPrompts(),
        cores().api().mcp.listResources(),
      ]);
      this.servers = servers;
      this.prompts = prompts;
      this.resources = resources;
      this.loadError = null;
    } catch (err) {
      log.warn("MCP refresh failed:", err);
      this.loadError = errMessage(err);
    }
  }

  async create(input: McpServerInput): Promise<McpServer> {
    const server = await cores().api().mcp.create(input);
    await this.refresh();
    return server;
  }

  async update(id: string, input: Partial<McpServerInput>): Promise<void> {
    await cores().api().mcp.update(id, input);
    await this.refresh();
  }

  async delete(id: string): Promise<void> {
    this.busy = { ...this.busy, [id]: true };
    try {
      await cores().api().mcp.delete(id);
      await this.refresh();
    } finally {
      const { [id]: _, ...rest } = this.busy;
      this.busy = rest;
    }
  }

  async reconnect(id: string): Promise<void> {
    this.busy = { ...this.busy, [id]: true };
    try {
      await cores().api().mcp.reconnect(id);
      await this.refresh();
    } finally {
      const { [id]: _, ...rest } = this.busy;
      this.busy = rest;
    }
  }

  /** Start OAuth sign-in for a remote server and open the authorization page in
   *  the browser. Completion arrives later via an mcp.snapshot frame. */
  async startOAuth(id: string): Promise<void> {
    const { authorizationUrl } = await cores().api().mcp.startOAuth(id);
    if (authorizationUrl) await platform().openExternal(authorizationUrl);
    else await this.refresh();
  }

  async setToolEnabled(id: string, tool: string, enabled: boolean): Promise<void> {
    await cores().api().mcp.setToolEnabled(id, tool, enabled);
    await this.refresh();
  }

  async setPromptEnabled(id: string, prompt: string, enabled: boolean): Promise<void> {
    await cores().api().mcp.setPromptEnabled(id, prompt, enabled);
    await this.refresh();
  }
}

export const mcpState = new McpState();
