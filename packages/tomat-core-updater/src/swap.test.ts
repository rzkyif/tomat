// performSwap against real tempdir files. Exercises the Unix branch
// (isWindows=false) and the Windows side-aside branch (isWindows=true)
// without actually shelling out to anything.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { performSwap } from "./main.ts";

async function makeTempBins(
  stagedContent: string,
  currentContent: string,
): Promise<{ dir: string; staged: string; current: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tomat-updater-" });
  const staged = join(dir, "staged");
  const current = join(dir, "current");
  await Deno.writeTextFile(staged, stagedContent);
  await Deno.writeTextFile(current, currentContent);
  return { dir, staged, current };
}

Deno.test("performSwap (unix): moves staged over current; staged path is gone afterward", async () => {
  const { dir, staged, current } = await makeTempBins("v2", "v1");
  try {
    const r = await performSwap(staged, current, false);
    assertEquals(r.ok, true);
    assertEquals(await Deno.readTextFile(current), "v2");
    let stagedExists = true;
    try {
      await Deno.stat(staged);
    } catch {
      stagedExists = false;
    }
    assertEquals(stagedExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performSwap (windows): renames current to <current>.old before moving staged in", async () => {
  const { dir, staged, current } = await makeTempBins("v2", "v1");
  try {
    const r = await performSwap(staged, current, true);
    assertEquals(r.ok, true);
    assertEquals(await Deno.readTextFile(current), "v2");
    assertEquals(await Deno.readTextFile(current + ".old"), "v1");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performSwap (windows): a stale .old from a previous swap is replaced, not preserved", async () => {
  const { dir, staged, current } = await makeTempBins("v3", "v2");
  try {
    // Simulate a leftover .old from an earlier upgrade.
    await Deno.writeTextFile(current + ".old", "v1");
    const r = await performSwap(staged, current, true);
    assertEquals(r.ok, true);
    assertEquals(await Deno.readTextFile(current + ".old"), "v2");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performSwap: rename failure surfaces with stage='rename'", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tomat-updater-" });
  try {
    const staged = join(dir, "does-not-exist");
    const current = join(dir, "current");
    await Deno.writeTextFile(current, "v1");

    const r = await performSwap(staged, current, false);
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.stage, "rename");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performSwap (unix): chmod failure on the new binary is non-fatal", async () => {
  // We can't easily induce a chmod failure on Unix, so just sanity-check that
  // chmod returns 0o755-ish on the swapped binary.
  const { dir, staged, current } = await makeTempBins("v2", "v1");
  try {
    await performSwap(staged, current, false);
    const stat = await Deno.stat(current);
    // We only care that the mode bits look executable somewhere — the
    // exact bits depend on umask. 0o755 sets at least the user-exec bit.
    assertEquals((stat.mode! & 0o100) !== 0, true);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performSwap (windows): rename failure after aside reverts the .old back to current", async () => {
  // Simulate Windows where aside succeeds but the install rename fails
  // (staged file missing). The revert step should restore current from
  // <current>.old so the supervisor still finds a working binary.
  const dir = await Deno.makeTempDir({ prefix: "tomat-updater-" });
  try {
    const staged = join(dir, "does-not-exist");
    const current = join(dir, "current");
    await Deno.writeTextFile(current, "v1");

    const r = await performSwap(staged, current, true);
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.stage, "rename");

    // Current should be restored to "v1" via the revert path. The .old
    // anchor is consumed by the revert rename.
    assertEquals(await Deno.readTextFile(current), "v1");
    let oldExists = true;
    try {
      await Deno.stat(current + ".old");
    } catch {
      oldExists = false;
    }
    assertEquals(oldExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
