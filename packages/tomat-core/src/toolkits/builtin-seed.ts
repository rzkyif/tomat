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
import { BUILTIN_TOOLKIT_ID, loadBuiltinToolkitManifest } from "./builtin-manifest.ts";
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
  if (await isSeeded()) {
    // Already seeded (or the user deleted it). Refresh the files when a newer
    // built-in version shipped, so an existing install isn't silently stuck
    // on the old toolset after an app update adds tools.
    await refreshBuiltinIfOutdated();
    return;
  }
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

  try {
    startDownload(
      { source: "builtin", preferLocalDir: join(paths().toolkitsDir, BUILTIN_TOOLKIT_ID) },
      wrapped,
    );
  } catch (err) {
    // A user-triggered install/update for the built-in may already hold the
    // per-toolkit lock; let that one win rather than failing boot seeding.
    log.warn(`built-in seed skipped: ${errMessage(err)}`);
  }
}

/** Detect (but do NOT auto-download) a newer built-in version. The cheap,
 *  signed manifest version check runs on boot; the tarball fetch is deferred to
 *  an explicit user action, since a download is never a silent boot side effect.
 *  The client's POST /toolkits/check-updates reports the available update and the
 *  user triggers the download + install via the normal toolkit update flow. A
 *  deleted built-in (no registry row) is left alone. */
async function refreshBuiltinIfOutdated(): Promise<void> {
  const installed = toolkitsRegistry().get(BUILTIN_TOOLKIT_ID);
  if (!installed) return; // user deleted it; don't resurrect
  let available: string;
  try {
    // force so a new release is detected past the cached manifest; in dev
    // this is ignored and resolves from the codebase.
    available = (await loadBuiltinToolkitManifest({ force: true })).version;
  } catch (err) {
    log.warn(`built-in version check failed; leaving install as-is: ${errMessage(err)}`);
    return;
  }
  if (available === installed.version) return;
  log.info(
    `built-in toolkit update available: ${installed.version} -> ${available} ` +
      `(update via the toolkit update flow)`,
  );
}
