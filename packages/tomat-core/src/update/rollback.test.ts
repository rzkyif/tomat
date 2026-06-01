// handleUpdateMarkerOnBoot: decision branches around the update
// marker file. Driven against tempdir-isolated paths().updateMarkerFile.
// The 30s cleanup setTimeout is left scheduled by the "first boot" case;
// we sanitizeOps:false on that test since we don't want to wait 30s.

import { assertEquals } from "@std/assert";
import { CORE_VERSION } from "../config.ts";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { handleUpdateMarkerOnBoot, type UpdateMarker, writeUpdateMarker } from "./rollback.ts";
import { paths } from "../paths.ts";

async function readRaw(): Promise<UpdateMarker | null> {
  try {
    return JSON.parse(await Deno.readTextFile(paths().updateMarkerFile));
  } catch {
    return null;
  }
}

Deno.test("handleUpdateMarkerOnBoot: returns false when no marker exists", async () => {
  const env = await setupTestEnv();
  try {
    assertEquals(await handleUpdateMarkerOnBoot(), false);
  } finally {
    await env.teardown();
  }
});

Deno.test("handleUpdateMarkerOnBoot: clears stale marker for a wholly different version", async () => {
  const env = await setupTestEnv();
  try {
    await writeUpdateMarker({
      version: "999.0.0",
      previousVersion: "998.0.0",
    });
    assertEquals(await handleUpdateMarkerOnBoot(), false);
    assertEquals(await readRaw(), null);
  } finally {
    await env.teardown();
  }
});

Deno.test("handleUpdateMarkerOnBoot: clears marker when running the rolled-back version", async () => {
  const env = await setupTestEnv();
  try {
    // Marker says v999 was being staged FROM CORE_VERSION; we're now back on
    // CORE_VERSION (already rolled back). Branch: previousVersion === running,
    // clear and continue.
    await writeUpdateMarker({
      version: "999.0.0",
      previousVersion: CORE_VERSION,
    });
    assertEquals(await handleUpdateMarkerOnBoot(), false);
    assertEquals(await readRaw(), null);
  } finally {
    await env.teardown();
  }
});

Deno.test({
  name: "handleUpdateMarkerOnBoot: first boot bumps attempts to 1 and schedules cleanup",
  // scheduleMarkerCleanup uses setTimeout(30_000); we don't want to wait for it.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    try {
      await writeUpdateMarker({
        version: CORE_VERSION,
        previousVersion: "0.0.1",
      });
      assertEquals(await handleUpdateMarkerOnBoot(), false);
      const after = await readRaw();
      assertEquals(after?.attempts, 1);
      assertEquals(after?.version, CORE_VERSION);
    } finally {
      await env.teardown();
    }
  },
});

Deno.test("writeUpdateMarker: persists attempts=0 + stagedAtMs at write time", async () => {
  const env = await setupTestEnv();
  const before = Date.now();
  try {
    await writeUpdateMarker({
      version: CORE_VERSION,
      previousVersion: "0.0.1",
    });
    const m = await readRaw();
    assertEquals(m?.attempts, 0);
    assertEquals(m?.version, CORE_VERSION);
    assertEquals(m?.previousVersion, "0.0.1");
    assertEquals(typeof m?.stagedAtMs, "number");
    assertEquals((m?.stagedAtMs ?? 0) >= before, true);
  } finally {
    await env.teardown();
  }
});

// --- performRollback (via attempts>=1 branch) -----------------------------

import { binPath, paths as _paths } from "../paths.ts";
import { binaryName, coreBinaryName } from "../binaries/versions.ts";

async function writeMarkerWithAttempts(attempts: number): Promise<void> {
  await Deno.writeTextFile(
    _paths().updateMarkerFile,
    JSON.stringify({
      version: CORE_VERSION,
      previousVersion: "0.0.1",
      attempts,
      stagedAtMs: Date.now(),
    }),
  );
}

Deno.test("handleUpdateMarkerOnBoot: returns false when rollback anchor is missing", async () => {
  const env = await setupTestEnv();
  try {
    await writeMarkerWithAttempts(1);
    // No <bin>.old anchor written, so performRollback should log + bail.
    assertEquals(await handleUpdateMarkerOnBoot(), false);
    // Marker cleared so we don't loop on next boot.
    assertEquals(await readRaw(), null);
  } finally {
    await env.teardown();
  }
});

Deno.test("handleUpdateMarkerOnBoot: rolls back current binary to <bin>.old contents", async () => {
  const env = await setupTestEnv();
  try {
    const currentBin = binPath(binaryName("tomat-core"));
    const oldBin = currentBin + ".old";
    await Deno.writeTextFile(currentBin, "BROKEN_V999");
    await Deno.writeTextFile(oldBin, "WORKING_V998");
    await writeMarkerWithAttempts(1);

    assertEquals(await handleUpdateMarkerOnBoot(), true);

    // currentBin now holds previous-version bytes.
    assertEquals(await Deno.readTextFile(currentBin), "WORKING_V998");
    // Broken binary preserved for post-mortem.
    assertEquals(await Deno.readTextFile(currentBin + ".broken"), "BROKEN_V999");
    // Original oldBin is consumed once the copy-first install committed.
    let oldStillThere = true;
    try {
      await Deno.stat(oldBin);
    } catch {
      oldStillThere = false;
    }
    assertEquals(oldStillThere, false);
    // Marker cleared.
    assertEquals(await readRaw(), null);
  } finally {
    await env.teardown();
  }
});

Deno.test("handleUpdateMarkerOnBoot: copy-first failure falls back to two-rename swap (still rolls back)", async () => {
  const env = await setupTestEnv();
  const originalCopyFile = Deno.copyFile;
  try {
    const currentBin = binPath(binaryName("tomat-core"));
    const oldBin = currentBin + ".old";
    await Deno.writeTextFile(currentBin, "BROKEN");
    await Deno.writeTextFile(oldBin, "WORKING");
    await writeMarkerWithAttempts(1);

    // Force the copy-first step to fail so the impl falls back to the
    // two-rename pattern (which consumes oldBin directly rather than via
    // the staged copy).
    (Deno as { copyFile: typeof Deno.copyFile }).copyFile = () =>
      Promise.reject(new Error("synthetic copy failure"));

    assertEquals(await handleUpdateMarkerOnBoot(), true);

    // Rollback still completed.
    assertEquals(await Deno.readTextFile(currentBin), "WORKING");
    assertEquals(await Deno.readTextFile(currentBin + ".broken"), "BROKEN");
    // In the fallback path oldBin was renamed (not copied), so it's gone
    // for a different reason than the happy path, but observably absent.
    let oldStillThere = true;
    try {
      await Deno.stat(oldBin);
    } catch {
      oldStillThere = false;
    }
    assertEquals(oldStillThere, false);
  } finally {
    (Deno as { copyFile: typeof Deno.copyFile }).copyFile = originalCopyFile;
    await env.teardown();
  }
});

Deno.test("handleUpdateMarkerOnBoot: a leftover <bin>.broken from a prior attempt is overwritten, not appended", async () => {
  const env = await setupTestEnv();
  try {
    const currentBin = binPath(binaryName("tomat-core"));
    const oldBin = currentBin + ".old";
    const brokenBin = currentBin + ".broken";
    await Deno.writeTextFile(currentBin, "NEW_BROKEN");
    await Deno.writeTextFile(oldBin, "WORKING");
    await Deno.writeTextFile(brokenBin, "PRIOR_BROKEN_LEFTOVER");
    await writeMarkerWithAttempts(1);

    assertEquals(await handleUpdateMarkerOnBoot(), true);
    assertEquals(await Deno.readTextFile(brokenBin), "NEW_BROKEN");
    assertEquals(await Deno.readTextFile(currentBin), "WORKING");
  } finally {
    await env.teardown();
  }
});

Deno.test("handleUpdateMarkerOnBoot: beta rolls back the channel-suffixed binary (tomat-core-beta)", async () => {
  const priorChannel = Deno.env.get("TOMAT_CHANNEL");
  Deno.env.set("TOMAT_CHANNEL", "beta");
  const env = await setupTestEnv();
  try {
    // The rollback anchor must follow the channel suffix, not the bare name.
    const currentBin = binPath(coreBinaryName("tomat-core"));
    assertEquals(currentBin.endsWith("tomat-core-beta"), true);
    const oldBin = currentBin + ".old";
    await Deno.writeTextFile(currentBin, "BROKEN_BETA");
    await Deno.writeTextFile(oldBin, "WORKING_BETA");
    await writeMarkerWithAttempts(1);

    assertEquals(await handleUpdateMarkerOnBoot(), true);
    assertEquals(await Deno.readTextFile(currentBin), "WORKING_BETA");
  } finally {
    await env.teardown();
    if (priorChannel === undefined) Deno.env.delete("TOMAT_CHANNEL");
    else Deno.env.set("TOMAT_CHANNEL", priorChannel);
  }
});
