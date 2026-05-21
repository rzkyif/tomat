// Self-update rollback on boot.
//
// The marker file (paths().updateMarkerFile) is written by selfUpdater
// before it hands off to tomat-core-updater. When the new core starts:
//
//   - First boot after update: marker exists with attempts=0. We set
//     attempts=1 and schedule deleteMarker() after MARKER_TTL_MS of
//     uptime. The marker delete also removes the `<bin>.old` rollback
//     anchor — past this point we consider the update committed.
//
//   - Second boot with marker still present: the previous boot crashed
//     before scheduling its delete. We trust that this means the new
//     binary is broken and roll back by swapping `<bin>.old` back over
//     `<bin>`. The current process (the broken binary) exits; the OS
//     supervisor (launchd / systemd-user / Scheduled Task) re-launches
//     `<bin>`, which is now the previous working version.
//
//   - Marker present but version unrelated to current: confused state;
//     log + delete marker, continue.

import { binaryName, hostTriple, platformExe } from "../binaries/versions.ts";
import { binPath, paths } from "../paths.ts";
import { getLogger } from "../shared/log.ts";
import { CORE_VERSION } from "../config.ts";

const log = getLogger("update.rollback");

// How long the new binary must stay up before we consider the update
// committed (and delete the marker + .old anchor). 30 s is generous
// enough to absorb slow-DB-open boots on cold storage but short enough
// that an actually-broken binary trips the rollback quickly.
const MARKER_TTL_MS = 30_000;

export interface UpdateMarker {
  // Version the updater intended to install (== CORE_VERSION of the new
  // binary on a healthy first boot).
  version: string;
  // Version we replaced (== CORE_VERSION of the `<bin>.old` rollback anchor).
  previousVersion: string;
  // Per-boot attempt count; bumped each time we see the marker.
  attempts: number;
  // Wall-clock ms when the marker was first written.
  stagedAtMs: number;
}

export async function writeUpdateMarker(
  m: Omit<UpdateMarker, "attempts" | "stagedAtMs">,
): Promise<void> {
  const full: UpdateMarker = {
    ...m,
    attempts: 0,
    stagedAtMs: Date.now(),
  };
  const tmp = paths().updateMarkerFile + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(full));
  await Deno.rename(tmp, paths().updateMarkerFile);
}

async function readMarker(): Promise<UpdateMarker | null> {
  try {
    const text = await Deno.readTextFile(paths().updateMarkerFile);
    return JSON.parse(text) as UpdateMarker;
  } catch {
    return null;
  }
}

async function deleteMarker(): Promise<void> {
  try {
    await Deno.remove(paths().updateMarkerFile);
  } catch { /* fine */ }
}

async function bumpAttempts(m: UpdateMarker): Promise<void> {
  const updated: UpdateMarker = { ...m, attempts: m.attempts + 1 };
  const tmp = paths().updateMarkerFile + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(updated));
  await Deno.rename(tmp, paths().updateMarkerFile);
}

function oldBinaryPath(): string {
  // Use the platform's actual binary name + .old suffix. On Windows the
  // updater used `.exe.old`; on Unix it's `<name>.old`.
  return binPath(binaryName("tomat-core" as never)) + ".old";
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// Called from main.ts before any service boots. Returns true if rollback
// happened (caller should exit immediately so the supervisor re-launches
// the now-restored old binary).
export async function handleUpdateMarkerOnBoot(): Promise<boolean> {
  const marker = await readMarker();
  if (!marker) return false;

  if (marker.version !== CORE_VERSION) {
    if (marker.previousVersion === CORE_VERSION) {
      // We rolled back already (or the swap never happened); clean up.
      log.info(
        `update marker present but we're already on previousVersion ` +
          `${CORE_VERSION}; clearing`,
      );
    } else {
      log.warn(
        `update marker version ${marker.version} doesn't match running ` +
          `${CORE_VERSION} and isn't previousVersion ${marker.previousVersion}; ` +
          `clearing`,
      );
    }
    await deleteMarker();
    return false;
  }

  if (marker.attempts >= 1) {
    // We saw the marker on a previous boot but never got to delete it →
    // the new binary crashed before MARKER_TTL_MS elapsed. Roll back.
    return await performRollback(marker);
  }

  // First boot after update. Mark the attempt and schedule cleanup.
  await bumpAttempts(marker);
  log.info(
    `update marker: first boot of v${marker.version} ` +
      `(was v${marker.previousVersion}); cleanup scheduled in ${
        MARKER_TTL_MS / 1000
      }s`,
  );
  scheduleMarkerCleanup();
  return false;
}

function scheduleMarkerCleanup(): void {
  setTimeout(() => {
    void (async () => {
      const oldBin = oldBinaryPath();
      try {
        await Deno.remove(oldBin);
        log.info(`update committed; removed rollback anchor ${oldBin}`);
      } catch { /* may not exist on first install — fine */ }
      await deleteMarker();
    })();
  }, MARKER_TTL_MS);
}

async function performRollback(marker: UpdateMarker): Promise<boolean> {
  const oldBin = oldBinaryPath();
  if (!(await exists(oldBin))) {
    log.error(
      `update marker says rollback needed but ${oldBin} is missing; ` +
        `cannot recover. Manual reinstall required.`,
    );
    await deleteMarker();
    return false;
  }
  const currentBin = binPath(binaryName("tomat-core" as never));
  const brokenBin = currentBin + ".broken";

  log.warn(
    `rolling back v${marker.version} → v${marker.previousVersion}: ` +
      `new binary failed to stay up past ${MARKER_TTL_MS / 1000}s`,
  );

  try {
    // Rename works on both Unix (atomic) and Windows (allowed while the
    // file is locked, unlike delete). Preserves the broken binary for
    // post-mortem inspection.
    try {
      await Deno.remove(brokenBin);
    } catch { /* fine */ }
    await Deno.rename(currentBin, brokenBin);
    await Deno.rename(oldBin, currentBin);
    if (Deno.build.os !== "windows") {
      try {
        await Deno.chmod(currentBin, 0o755);
      } catch { /* ignore */ }
    }
  } catch (err) {
    log.error(
      `rollback failed: ${err instanceof Error ? err.message : err}`,
    );
    await deleteMarker();
    return false;
  }
  await deleteMarker();
  log.info(
    `rolled back. exiting so the supervisor relaunches v${marker.previousVersion}.`,
  );
  return true;
}

// Triple is referenced for type checking by versions.ts re-export; silence
// the unused warning the linter would otherwise emit.
void hostTriple;
void platformExe;
