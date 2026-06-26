// Tier 2: settings round-trip. A core-destination setting changed in the UI
// state layer flushes to core and persists (survives a re-read from core).
import { afterEach, expect, test, vi } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { cores } from "@client/lib/core/cores.ts";
import { settingsState } from "@client/state/settings.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("a core setting change persists to core", async () => {
  app = await launchApp({ scenario: "paired" });
  await app.chat.waitReady();

  await settingsState.updateSetting("llm.temperature", 0.42);

  // Poll the core's persisted settings until the debounced flush lands.
  await vi.waitFor(
    async () => {
      const persisted = await cores().api().settings.load();
      expect(persisted["llm.temperature"]).toBe(0.42);
    },
    { timeout: 10_000, interval: 300 },
  );
});
