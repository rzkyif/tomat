// Tier 2: MCP. Connecting a stdio MCP server (a hermetic, dependency-free fake)
// registers it and surfaces its tool through the client mcp state.
import { afterEach, expect, test, vi } from "vitest";
import { commands } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { mcpState } from "@client/state/mcp.svelte";
import { messagesState } from "@client/state/messages.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

// Connect the hermetic stdio MCP server and wait until its tool is discovered.
async function connectTestMcp(): Promise<string> {
  mcpState.attach();
  const serverPath = await commands.fixturePath("mcp-server.ts");
  const server = await mcpState.create({
    name: "test-mcp",
    kind: "stdio",
    command: "deno",
    args: ["run", "--allow-read", serverPath],
    runtime: "custom",
    enabled: true,
  });
  expect(server.id).toBeTruthy();
  await vi.waitFor(
    async () => {
      await mcpState.refresh();
      const s = mcpState.servers.find((x) => x.name === "test-mcp");
      expect(s?.status).toBe("connected");
      expect((s?.toolCount ?? 0) >= 1).toBe(true);
    },
    { timeout: 25_000, interval: 500 },
  );
  return server.id;
}

test("connects a stdio MCP server and discovers its tool", async () => {
  app = await launchApp({ scenario: "paired" });
  await app.chat.waitReady();
  await connectTestMcp();
});

test("the model calls an MCP tool; core proxies it over stdio and answers", async () => {
  app = await launchApp({
    scenario: "paired",
    settings: { "tools.enabled": true, "tools.filteringEnabled": false },
    llm: {
      kind: "toolThenText",
      // The MCP "ping" tool is offered to the model under its raw name.
      tool: { name: "ping", arguments: { text: "hi" } },
      text: "the mcp tool replied",
    },
  });
  await app.chat.waitReady();
  const serverId = await connectTestMcp();
  await mcpState.setToolEnabled(serverId, "ping", true);

  await app.chat.send("call the ping tool");

  // Core proxies the call to the stdio server (returns "pong") and the tool
  // message completes; the next turn produces the final answer.
  await vi.waitFor(
    () => {
      const t = messagesState.messages.find((m) => m.role === "tool");
      expect((t as { status?: string } | undefined)?.status).toBe("completed");
    },
    { timeout: 30_000, interval: 300 },
  );
  await app.chat.expectText("the mcp tool replied");
}, 60_000);
