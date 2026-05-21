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

interface Args {
  staged: string;
  current: string;
  restartArgs: string;
}

function readArgs(): Args {
  const { staged, current, "restart-args": restartArgs } = parseArgs(
    Deno.args,
    {
      string: ["staged", "current", "restart-args"],
    },
  );
  if (!staged || !current) {
    console.error(
      "usage: tomat-core-updater --staged <path> --current <path> [--restart-args <json>]",
    );
    Deno.exit(2);
  }
  return { staged, current, restartArgs: restartArgs ?? "[]" };
}

async function main(): Promise<void> {
  const args = readArgs();
  // Let core exit cleanly.
  await new Promise((r) => setTimeout(r, 2_000));

  // Move the new binary into place.
  const isWindows = Deno.build.os === "windows";
  try {
    if (isWindows) {
      const oldPath = args.current + ".old";
      try {
        await Deno.remove(oldPath);
      } catch { /* fine */ }
      try {
        await Deno.rename(args.current, oldPath);
      } catch (err) {
        console.error("failed to move current binary aside:", err);
        Deno.exit(3);
      }
    }
    await Deno.rename(args.staged, args.current);
    if (!isWindows) {
      try {
        await Deno.chmod(args.current, 0o755);
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error("failed to install staged binary:", err);
    Deno.exit(4);
  }

  // Restart the new core in detached mode.
  let restartArgs: string[];
  try {
    restartArgs = JSON.parse(args.restartArgs) as string[];
  } catch {
    restartArgs = [];
  }
  const proc = new Deno.Command(args.current, {
    args: restartArgs,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  proc.spawn();
}

if (import.meta.main) {
  await main();
}
