// Tier 2: the declarative scenario seed. launchApp({ seed }) sets up starting
// state over REST before the app mounts, so a spec can express "an app that
// already has N sessions" instead of scripting the clicks to create them.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { sessionsState } from "@client/state/sessions.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("seed.sessions pre-creates sessions before the app mounts", async () => {
  app = await launchApp({ scenario: "paired", seed: { sessions: 3 } });
  await app.chat.waitReady();

  await sessionsState.loadList();
  expect(sessionsState.list.length).toBeGreaterThanOrEqual(3);
}, 60_000);
