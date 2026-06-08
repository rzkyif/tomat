// First-boot seeding of the built-in toolkit. On a fresh install the core
// install script places the toolkit files under the toolkits dir; this registers
// + activates them (or falls back to the CDN, or the codebase in dev). A sparse
// marker setting records a successful seed so that after a user deletes the
// built-in it does NOT come back on the next boot.

import { join } from "@std/path";
import { errMessage } from "@tomat/shared";
import { loadCoreSettings, patchCoreSettings } from "../services/core-settings.ts";
import { paths } from "../paths.ts";
import { getLogger } from "../shared/log.ts";
import { type InstallEventSink, startDownload } from "./installer.ts";
import { BUILTIN_TOOLKIT_ID } from "./builtin-manifest.ts";
import { toolkitsRegistry } from "./registry.ts";

const log = getLogger("builtin-seed");

/** Sparse, internal core setting (NOT in the shared settings schema/UI): true
 *  once the built-in has been seeded at least once. */
export const BUILTIN_SEEDED_KEY = "toolkits.builtinSeeded";

export async function seedBuiltinToolkitIfNeeded(sink: InstallEventSink): Promise<void> {
  const settings = await loadCoreSettings();
  if (settings[BUILTIN_SEEDED_KEY] === true) return; // already seeded / deleted by the user
  if (toolkitsRegistry().get(BUILTIN_TOOLKIT_ID)) {
    // Present already (downloaded by a prior boot, or installed manually): just
    // record the seed so a later user delete isn't undone on the next boot.
    await patchCoreSettings({ [BUILTIN_SEEDED_KEY]: true });
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
      if (ok) {
        void patchCoreSettings({ [BUILTIN_SEEDED_KEY]: true }).catch((err) =>
          log.warn(`failed to set seed marker: ${errMessage(err)}`),
        );
      }
    },
  };

  startDownload(
    { source: "builtin", preferLocalDir: join(paths().toolkitsDir, BUILTIN_TOOLKIT_ID) },
    wrapped,
  );
}
