// Tier 2: snippets. A created snippet persists (via platform().snippetFiles,
// in-memory in the harness) and appears in the snippet list the composer
// autocomplete reads.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { snippetsState } from "@client/state/snippets.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("creating a snippet adds it to the snippet list", async () => {
  app = await launchApp({ scenario: "paired" });
  await app.chat.waitReady();

  const created = await snippetsState.create({
    name: "Greeting",
    symbol: "@",
    symbolPinned: false,
    placement: "append-system",
    text: "Always greet the user warmly.",
  });
  expect(snippetsState.snippets.some((s) => s.id === created.id)).toBe(true);

  // Survives a reload from the (in-memory) snippet store.
  await snippetsState.load();
  expect(snippetsState.snippets.some((s) => s.text === "Always greet the user warmly.")).toBe(true);
});
