// core-settings sparse persistence: load + patch + atomic write +
// listener fan-out. File-backed via tempdir.

import { assertEquals } from "@std/assert";
import { loadCoreSettings, patchCoreSettings, subscribeCoreSettings } from "./core-settings.ts";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";

Deno.test("loadCoreSettings: returns {} when settings.json does not exist", async () => {
  const env = await setupTestEnv();
  try {
    assertEquals(await loadCoreSettings(), {});
  } finally {
    await env.teardown();
  }
});

Deno.test("patchCoreSettings: adds and persists the key", async () => {
  const env = await setupTestEnv();
  try {
    const merged = await patchCoreSettings({ theme: "dark" });
    assertEquals(merged.theme, "dark");
    const onDisk = JSON.parse(await Deno.readTextFile(paths().settingsFile));
    assertEquals(onDisk.theme, "dark");
  } finally {
    await env.teardown();
  }
});

Deno.test("patchCoreSettings: null/undefined deletes the key (sparse storage)", async () => {
  const env = await setupTestEnv();
  try {
    await patchCoreSettings({ k1: "v1", k2: "v2" });
    const after = await patchCoreSettings({ k1: null });
    assertEquals("k1" in after, false);
    assertEquals(after.k2, "v2");
  } finally {
    await env.teardown();
  }
});

Deno.test("patchCoreSettings: same value is a no-op (not in changedKeys)", async () => {
  const env = await setupTestEnv();
  try {
    await patchCoreSettings({ k: "v" });
    let fired = 0;
    let lastChangedSize = -1;
    const unsubscribe = subscribeCoreSettings((_s, changed) => {
      fired++;
      lastChangedSize = changed.size;
    });
    try {
      await patchCoreSettings({ k: "v" });
      // No change, no listener fire.
      assertEquals(fired, 0);
      await patchCoreSettings({ k: "v2" });
      assertEquals(fired, 1);
      assertEquals(lastChangedSize, 1);
    } finally {
      unsubscribe();
    }
  } finally {
    await env.teardown();
  }
});

Deno.test("subscribeCoreSettings: unsubscribe stops the listener", async () => {
  const env = await setupTestEnv();
  try {
    let fired = 0;
    const unsubscribe = subscribeCoreSettings(() => {
      fired++;
    });
    await patchCoreSettings({ k: "v" });
    assertEquals(fired, 1);
    unsubscribe();
    await patchCoreSettings({ k: "v2" });
    assertEquals(fired, 1);
  } finally {
    await env.teardown();
  }
});
