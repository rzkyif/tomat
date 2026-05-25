// tomat-core-updater: tiny standalone Deno entry that's compiled to its own
// binary, separate from tomat-core. When invoked by core's self-updater
// flow, it:
//   1. Waits 2s for the parent core process to exit.
//   2. Atomically renames `--staged` over `--current`. On Windows, the
//      currently-running .exe can't be replaced directly, so it renames
//      the old .exe to <name>.exe.old first; that .old is deleted on the
//      next core boot.
//   3. Spawns the new core binary with `--restart-args` (forwarded back as
//      the new process's argv) and exits.
//
// This binary needs `--allow-read --allow-write --allow-run` when run.

import { parseArgs } from "@std/cli";
import { dirname, join } from "@std/path";

// --- persistent log -------------------------------------------------------
//
// Until now the updater logged to stderr of a process spawned `stdin: null,
// stdout: null, stderr: null` from core's self-updater. When a swap failed
// (Windows file lock, anti-virus interception, etc.), the error vanished
// because there was nothing collecting that stderr. Append-to-file lets a
// user reading `~/.tomat/core/logs/updater.log` see exactly what happened.
//
// Path resolution mirrors `tomat-core/src/paths.ts`: TOMAT_CORE_HOME wins
// when set; otherwise `${HOME or USERPROFILE}/.tomat/core`. Kept inline to
// keep the updater free of cross-package deps (it ships as its own
// standalone binary).

function resolveLogPath(): string | null {
  const explicit = Deno.env.get("TOMAT_CORE_HOME");
  if (explicit && explicit.length > 0) {
    return join(explicit, "logs", "updater.log");
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home || home.length === 0) return null;
  return join(home, ".tomat", "core", "logs", "updater.log");
}

let logFileHandle: Deno.FsFile | null = null;

function openLogSync(): Deno.FsFile | null {
  const path = resolveLogPath();
  if (!path) return null;
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
    return Deno.openSync(path, { create: true, append: true });
  } catch {
    return null;
  }
}

function ulog(level: "info" | "warn" | "error", msg: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`;
  if (!logFileHandle) logFileHandle = openLogSync();
  if (logFileHandle) {
    try {
      logFileHandle.writeSync(new TextEncoder().encode(line));
    } catch {
      /* drop — disk full, file gone; stderr is the only fallback */
    }
  }
  // Mirror to stderr too; supervisors capturing journald / launchd get it
  // alongside the file copy.
  if (level === "error" || level === "warn") {
    console.error(line.trimEnd());
  }
}

function closeLog(): void {
  if (logFileHandle) {
    try {
      logFileHandle.close();
    } catch { /* */ }
    logFileHandle = null;
  }
}

export interface Args {
  staged: string;
  current: string;
  restartArgs: string;
}

export type ArgsResult =
  | { ok: true; value: Args }
  | { ok: false; reason: "missing-required" };

/** Pure arg parser. Exported for tests; `main()` adapts the error result
 *  into a process exit. */
export function parseUpdaterArgs(argv: string[]): ArgsResult {
  const { staged, current, "restart-args": restartArgs } = parseArgs(
    argv,
    { string: ["staged", "current", "restart-args"] },
  );
  if (!staged || !current) {
    return { ok: false, reason: "missing-required" };
  }
  return {
    ok: true,
    value: { staged, current, restartArgs: restartArgs ?? "[]" },
  };
}

function readArgs(): Args {
  const result = parseUpdaterArgs(Deno.args);
  if (!result.ok) {
    console.error(
      "usage: tomat-core-updater --staged <path> --current <path> [--restart-args <json>]",
    );
    Deno.exit(2);
  }
  return result.value;
}

export type SwapResult =
  | { ok: true }
  | { ok: false; stage: "aside" | "rename"; error: unknown };

/** Move `staged` over `current`, setting aside the old binary on Windows
 *  first. Pure-ish: takes the platform flag explicitly so tests don't have
 *  to spoof `Deno.build.os`. On Unix, a single `rename` is atomic and
 *  overwrites in place — no rework needed. On Windows the running .exe
 *  can't be deleted but can be renamed, so we move it aside first; if the
 *  follow-on install rename fails we revert the aside so the supervisor
 *  isn't left without a binary. */
export async function performSwap(
  staged: string,
  current: string,
  isWindows: boolean,
): Promise<SwapResult> {
  if (isWindows) {
    const oldPath = current + ".old";
    try {
      await Deno.remove(oldPath);
    } catch { /* fine */ }
    try {
      await Deno.rename(current, oldPath);
    } catch (err) {
      return { ok: false, stage: "aside", error: err };
    }
    try {
      await Deno.rename(staged, current);
    } catch (err) {
      // Install rename failed after we'd moved current aside. Revert the
      // aside so the supervisor finds the previous (working) binary at
      // currentBin on its next relaunch.
      try {
        await Deno.rename(oldPath, current);
      } catch { /* the caller logs and exits; manual recovery from .old */ }
      return { ok: false, stage: "rename", error: err };
    }
    return { ok: true };
  }
  try {
    await Deno.rename(staged, current);
  } catch (err) {
    return { ok: false, stage: "rename", error: err };
  }
  try {
    await Deno.chmod(current, 0o755);
  } catch { /* ignore */ }
  return { ok: true };
}

async function main(): Promise<void> {
  const args = readArgs();
  ulog("info", `started; staged=${args.staged} current=${args.current}`);
  // Let core exit cleanly.
  await new Promise((r) => setTimeout(r, 2_000));

  const isWindows = Deno.build.os === "windows";
  const swap = await performSwap(args.staged, args.current, isWindows);
  if (!swap.ok) {
    const errMsg = swap.error instanceof Error
      ? swap.error.message
      : String(swap.error);
    if (swap.stage === "aside") {
      ulog("error", `failed to move current binary aside: ${errMsg}`);
      closeLog();
      Deno.exit(3);
    }
    ulog("error", `failed to install staged binary: ${errMsg}`);
    closeLog();
    Deno.exit(4);
  }
  ulog("info", "swap committed");

  // Restart the new core in detached mode.
  let restartArgs: string[];
  try {
    restartArgs = JSON.parse(args.restartArgs) as string[];
  } catch {
    restartArgs = [];
  }
  try {
    const proc = new Deno.Command(args.current, {
      args: restartArgs,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    proc.spawn();
    ulog("info", "spawned new core; exiting");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    ulog("error", `failed to spawn new core: ${errMsg}`);
    // Revert the swap so the next boot doesn't pick up a binary that won't
    // start. On Unix swap the staged file back under the old name; on
    // Windows restore the `.old` we set aside earlier.
    try {
      if (isWindows) {
        const oldPath = args.current + ".old";
        await Deno.remove(args.current).catch(() => {});
        await Deno.rename(oldPath, args.current);
      } else {
        await Deno.rename(args.current, args.staged);
      }
      ulog("warn", "swap reverted after spawn failure");
    } catch (revertErr) {
      const rErr = revertErr instanceof Error
        ? revertErr.message
        : String(revertErr);
      ulog("error", `revert failed; manual intervention required: ${rErr}`);
    }
    closeLog();
    Deno.exit(5);
  }
  closeLog();
}

if (import.meta.main) {
  await main();
}
