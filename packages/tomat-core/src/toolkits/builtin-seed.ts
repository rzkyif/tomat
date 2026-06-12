// First-boot seeding of the built-in toolkit. On a fresh install the core
// install script places the toolkit files under the toolkits dir; this registers
// + activates them (or falls back to the CDN, or the codebase in dev). A marker
// file records a successful seed so that after a user deletes the built-in it
// does NOT come back on the next boot.

import { join } from "@std/path";
import { errMessage } from "@tomat/shared";
import { paths } from "../paths.ts";
import { getLogger } from "../shared/log.ts";
import { type InstallEventSink, startDownload } from "./installer.ts";
import { BUILTIN_TOOLKIT_ID } from "./builtin-manifest.ts";
import { toolkitsRegistry } from "./registry.ts";

const log = getLogger("builtin-seed");

async function isSeeded(): Promise<boolean> {
  try {
    await Deno.stat(paths().builtinSeededMarkerFile);
    return true;
  } catch {
    return false;
  }
}

async function recordSeeded(): Promise<void> {
  try {
    await Deno.writeTextFile(paths().builtinSeededMarkerFile, "");
  } catch (err) {
    log.warn(`failed to write seed marker: ${errMessage(err)}`);
  }
}

export async function seedBuiltinToolkitIfNeeded(sink: InstallEventSink): Promise<void> {
  if (await isSeeded()) return; // already seeded / deleted by the user
  if (toolkitsRegistry().get(BUILTIN_TOOLKIT_ID)) {
    // Present already (downloaded by a prior boot, or installed manually): just
    // record the seed so a later user delete isn't undone on the next boot.
    await recordSeeded();
    return;
  }

  // First boot: DOWNLOAD the built-in only, leaving it at status 'downloaded'.
  // We deliberately do NOT auto-install its deps: installing needs the deno
  // worker runtime (which may not be downloaded yet this early in boot), and -
  // like every other toolkit - Install + per-tool Enable are explicit user
  // steps. The seed marker flips after a successful download so a user who
  // deletes the built-in later doesn't get it re-seeded.
  const wrapped: InstallEventSink = {
    log: (jobId, id, stream, line) => sink.log(jobId, id, stream, line),
    done: (jobId, id, ok, code) => {
      sink.done(jobId, id, ok, code);
      if (ok) void recordSeeded();
    },
  };

  startDownload(
    { source: "builtin", preferLocalDir: join(paths().toolkitsDir, BUILTIN_TOOLKIT_ID) },
    wrapped,
  );
}
