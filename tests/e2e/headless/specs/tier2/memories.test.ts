// Tier 2: memories. A created memory round-trips through core and appears in the
// memory list; toggling memories.enabled is honored.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { memoriesState } from "@client/state/memories.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("creating a memory adds it to the memory list", async () => {
  app = await launchApp({ scenario: "paired", settings: { "memories.enabled": true } });
  await app.chat.waitReady();
  await memoriesState.attach();

  const mem = await memoriesState.create("knowledge", "Favourite colour", "The user likes teal.");
  // create() reloads the list from core, so the new memory is listed by id.
  expect(memoriesState.memories.some((m) => m.id === mem.id)).toBe(true);

  // Survives an independent reload from core.
  await memoriesState.load();
  expect(memoriesState.memories.some((m) => m.title === "Favourite colour")).toBe(true);
});
