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
import { type InstallEventSink, startDownload, startInstallDeps } from "./installer.ts";
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
    // Present already (e.g. installed manually before the first seed ran).
    await patchCoreSettings({ [BUILTIN_SEEDED_KEY]: true });
    return;
  }

  // First boot: download the built-in, then install its deps so it ends up
  // 'installed' (ready for the user to enable tools). The seed marker flips only
  // after the install phase succeeds; an offline/failed first boot leaves it
  // unset so the next boot retries. (Tools start disabled; the user enables.)
  const installSink: InstallEventSink = {
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

  const downloadSink: InstallEventSink = {
    log: (jobId, id, stream, line) => sink.log(jobId, id, stream, line),
    done: (jobId, id, ok, code) => {
      sink.done(jobId, id, ok, code);
      if (ok) startInstallDeps(BUILTIN_TOOLKIT_ID, installSink);
    },
  };

  startDownload(
    { source: "builtin", preferLocalDir: join(paths().toolkitsDir, BUILTIN_TOOLKIT_ID) },
    downloadSink,
  );
}
