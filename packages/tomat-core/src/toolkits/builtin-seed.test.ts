// Seed-marker logic for the built-in toolkit. The two branches here never touch
// the network (marker-already-set and already-installed); the actual CDN/codebase
// install path is exercised by the installer tests + manual verification.

import { assertEquals, assertExists } from "@std/assert";
import { BUILTIN_TOOLKIT_ID } from "@tomat/shared";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { BUILTIN_SEEDED_KEY, seedBuiltinToolkitIfNeeded } from "./builtin-seed.ts";
import { toolkitsRegistry } from "./registry.ts";
import { loadCoreSettings, patchCoreSettings } from "../services/core-settings.ts";
import type { InstallEventSink } from "./installer.ts";

const NOOP_SINK: InstallEventSink = {
  log() {},
  done() {},
};

Deno.test("seedBuiltinToolkitIfNeeded: no-ops when the marker is already set", async () => {
  const env = await setupTestEnv();
  try {
    await patchCoreSettings({ [BUILTIN_SEEDED_KEY]: true });
    await seedBuiltinToolkitIfNeeded(NOOP_SINK);
    // Respects a prior delete: nothing is (re)installed and the marker stays set.
    assertEquals(toolkitsRegistry().list().length, 0);
    assertEquals((await loadCoreSettings())[BUILTIN_SEEDED_KEY], true);
  } finally {
    await env.teardown();
  }
});

Deno.test("seedBuiltinToolkitIfNeeded: adopts an existing built-in and marks seeded", async () => {
  const env = await setupTestEnv();
  try {
    toolkitsRegistry().upsertToolkit({
      id: BUILTIN_TOOLKIT_ID,
      source: "builtin",
      displayName: "tomat built-in toolkit",
      version: "1.0.0",
      installedPath: "/tmp/tomat-builtin-toolkit",
      toolsJsonHash: "h",
      contentHash: "c",
    });
    await seedBuiltinToolkitIfNeeded(NOOP_SINK);
    // An already-present built-in just records the seed marker (no re-download).
    assertEquals((await loadCoreSettings())[BUILTIN_SEEDED_KEY], true);
    assertExists(toolkitsRegistry().get(BUILTIN_TOOLKIT_ID));
  } finally {
    await env.teardown();
  }
});
