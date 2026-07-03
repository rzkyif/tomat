// Tier 2: extensions. Installing a local (hermetic, no-dep) extension copies it
// into core, installs it, and surfaces it + its tool in the client state.
import { afterEach, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { extensionsState } from "@client/state/extensions.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("installs a local extension and lists it with its tool", async () => {
  app = await launchApp({ scenario: "paired" });
  // waitReady() resolves once the app is connected; the mounted app already
  // ran extensionsState.attach() on that connected edge, so the WS feed that
  // awaitJob() relies on is live.
  await app.chat.waitReady();

  const path = await commands.fixturePath("test-extension");
  const downloadJob = await extensionsState.download({ source: "local", slug: "test-echo", path });
  await extensionsState.awaitJob(downloadJob);
  const installJob = await extensionsState.installDeps("test-echo");
  await extensionsState.awaitJob(installJob);

  await extensionsState.refresh();
  const ext = extensionsState.installed.find((e) => e.id === "test-echo");
  expect(ext, "extension installed").toBeTruthy();
  expect(ext?.toolCount ?? 0).toBeGreaterThanOrEqual(1);

  const tools = await extensionsState.loadTools("test-echo");
  expect(tools.some((t) => t.name === "echo_tool")).toBe(true);
}, 60_000);
