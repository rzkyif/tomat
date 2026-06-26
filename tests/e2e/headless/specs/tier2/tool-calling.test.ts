// Tier 2: tool calling. A scripted tool call is executed by core (in the real
// deno worker) against a hermetic local extension; its result feeds the next
// turn, which produces the final answer.
import { afterEach, expect, test, vi } from "vitest";
import { commands } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { extensionsState } from "@client/state/extensions.svelte";
import { messagesState } from "@client/state/messages.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

// Install + enable the hermetic echo tool in the running app's primary core.
async function installEchoTool(a: AppHandle): Promise<void> {
  await a.chat.waitReady();
  await extensionsState.ensureConnected();
  const path = await commands.fixturePath("test-extension");
  await extensionsState.awaitJob(
    await extensionsState.download({ source: "local", slug: "test-echo", path }),
  );
  await extensionsState.awaitJob(await extensionsState.installDeps("test-echo"));
  await extensionsState.enableTool("test-echo", "echo_tool");
}

function completedTools(): number {
  return messagesState.messages.filter(
    (m) => m.role === "tool" && (m as { status?: string }).status === "completed",
  ).length;
}

test("the model calls a tool, core executes it, and the final turn answers", async () => {
  app = await launchApp({
    scenario: "paired",
    // Always send tools (no relevance filtering), and ensure tools are on.
    settings: { "tools.enabled": true, "tools.filteringEnabled": false },
    llm: {
      kind: "toolThenText",
      tool: { name: "echo_tool", arguments: { text: "ping-123" } },
      text: "the tool echoed ping-123",
    },
  });
  await installEchoTool(app);

  await app.chat.send("use the echo tool");

  // The deno worker runs the tool; wait until a tool message reaches "completed"
  // (a stuck or failed execution fails here instead of silently falling through).
  await vi.waitFor(() => expect(completedTools()).toBeGreaterThanOrEqual(1), {
    timeout: 30_000,
    interval: 300,
  });

  // The second turn (with the tool result present) produces the final answer.
  await app.chat.expectText("the tool echoed ping-123");
}, 60_000);

test("the model calls several tools in one turn; core executes all, then answers", async () => {
  app = await launchApp({
    scenario: "paired",
    settings: { "tools.enabled": true, "tools.filteringEnabled": false },
    llm: {
      kind: "multiTool",
      tools: [
        { name: "echo_tool", arguments: { text: "alpha" } },
        { name: "echo_tool", arguments: { text: "beta" } },
      ],
      text: "both tools echoed",
    },
  });
  await installEchoTool(app);

  await app.chat.send("use the echo tool twice");

  // Both tool calls run in the real worker and complete before the final turn.
  await vi.waitFor(() => expect(completedTools()).toBeGreaterThanOrEqual(2), {
    timeout: 30_000,
    interval: 300,
  });
  await app.chat.expectText("both tools echoed");
}, 60_000);
