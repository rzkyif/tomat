// Seed-marker logic for the built-in extension. The two branches here never touch
// the network (marker-already-set and already-installed); the actual CDN/codebase
// install path is exercised by the installer tests + manual verification.

import { assertEquals, assertExists } from "@std/assert";
import { BUILTIN_EXTENSION_ID } from "@tomat/shared";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { seedBuiltinExtensionIfNeeded } from "./builtin-seed.ts";
import { extensionsRegistry } from "./registry.ts";
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

Deno.test("seedBuiltinExtensionIfNeeded: no-ops when the marker is already set", async () => {
  const env = await setupTestEnv();
  try {
    await Deno.writeTextFile(paths().builtinSeededMarkerFile, "");
    await seedBuiltinExtensionIfNeeded(NOOP_SINK);
    // Respects a prior delete: nothing is (re)installed and the marker stays set.
    assertEquals(extensionsRegistry().list().length, 0);
    assertEquals(await markerExists(), true);
  } finally {
    await env.teardown();
  }
});

Deno.test("seedBuiltinExtensionIfNeeded: adopts an existing built-in and marks seeded", async () => {
  const env = await setupTestEnv();
  try {
    extensionsRegistry().upsertExtension({
      id: BUILTIN_EXTENSION_ID,
      source: "builtin",
      displayName: "tomat built-in extension",
      version: "1.0.0",
      installedPath: "/tmp/tomat-builtin",
      manifestHash: "h",
      contentHash: "c",
    });
    await seedBuiltinExtensionIfNeeded(NOOP_SINK);
    // An already-present built-in just records the seed marker (no re-download).
    assertEquals(await markerExists(), true);
    assertExists(extensionsRegistry().get(BUILTIN_EXTENSION_ID));
  } finally {
    await env.teardown();
  }
});
