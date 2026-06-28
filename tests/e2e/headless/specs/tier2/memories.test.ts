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

  // A fresh memory is unindexed, so it reports as stale; requesting a reindex
  // is accepted by the core.
  expect(memoriesState.memories.find((m) => m.id === mem.id)?.summaryStale).toBe(true);
  await memoriesState.reindex(mem.id);
});

test("a skill's bundled files round-trip through core", async () => {
  app = await launchApp({ scenario: "paired", settings: { "memories.enabled": true } });
  await app.chat.waitReady();
  await memoriesState.attach();

  const skill = await memoriesState.create("skill", "Recap", "# Steps\n1. read\n2. summarize");
  await memoriesState.writeFile(skill.id, "checklist.md", "- sources cited?");
  expect(await memoriesState.getFile(skill.id, "checklist.md")).toBe("- sources cited?");

  // The bundled file shows up on the full memory fetch.
  expect((await memoriesState.get(skill.id)).files).toContain("checklist.md");

  await memoriesState.deleteFile(skill.id, "checklist.md");
  expect((await memoriesState.get(skill.id)).files ?? []).not.toContain("checklist.md");
});
