// Seed-marker logic for the built-in toolkit. The two branches here never touch
// the network (marker-already-set and already-installed); the actual CDN/codebase
// install path is exercised by the installer tests + manual verification.

import { assertEquals, assertExists } from "@std/assert";
import { BUILTIN_TOOLKIT_ID } from "@tomat/shared";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { seedBuiltinToolkitIfNeeded } from "./builtin-seed.ts";
import { toolkitsRegistry } from "./registry.ts";
import { paths } from "../paths.ts";
import type { InstallEventSink } from "./installer.ts";

const NOOP_SINK: InstallEventSink = {
  log() {},
  done() {},
};

async function markerExists(): Promise<boolean> {
  try {
    await Deno.stat(paths().builtinSeededMarkerFile);
    return true;
  } catch {
    return false;
  }
}

Deno.test("seedBuiltinToolkitIfNeeded: no-ops when the marker is already set", async () => {
  const env = await setupTestEnv();
  try {
    await Deno.writeTextFile(paths().builtinSeededMarkerFile, "");
    await seedBuiltinToolkitIfNeeded(NOOP_SINK);
    // Respects a prior delete: nothing is (re)installed and the marker stays set.
    assertEquals(toolkitsRegistry().list().length, 0);
    assertEquals(await markerExists(), true);
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
    assertEquals(await markerExists(), true);
    assertExists(toolkitsRegistry().get(BUILTIN_TOOLKIT_ID));
  } finally {
    await env.teardown();
  }
});
