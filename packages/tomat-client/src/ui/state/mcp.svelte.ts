/**
 * Reactive store for configured MCP servers and their prompts/resources. The
 * core owns the connections; this mirrors the projected state for the MCP
 * settings manager, the Tools manager (MCP tools), and the "/" + "@"
 * autocomplete. Refreshed on connect and on every `mcp.snapshot` frame.
 */

import type { McpPrompt, McpResource, McpServer, ServerToClientFrame } from "@tomat/shared";
import { cores } from "$lib/core/cores";
import type { McpServerInput } from "$lib/core/mcp";
import { getLogger } from "$lib/util/log";

const log = getLogger("mcp");

class McpState {
  servers = $state<McpServer[]>([]);
  prompts = $state<McpPrompt[]>([]);
  resources = $state<McpResource[]>([]);
  wsConnected = $state(false);

  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeConn: (() => void) | null = null;

  attach(): void {
    if (this.unsubscribeWs) return;
    this.unsubscribeWs = cores().subscribeWs((f) => this.onFrame(f));
    this.unsubscribeConn = cores().subscribeConnectionState((state) => {
      this.wsConnected = state === "connected";
      if (state === "connected") void this.refresh();
    });
  }

  detach(): void {
    this.unsubscribeWs?.();
    this.unsubscribeConn?.();
    this.unsubscribeWs = null;
    this.unsubscribeConn = null;
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
    } catch (err) {
      log.warn("MCP refresh failed:", err);
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
    await cores().api().mcp.delete(id);
    await this.refresh();
  }

  async reconnect(id: string): Promise<void> {
    await cores().api().mcp.reconnect(id);
    await this.refresh();
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
