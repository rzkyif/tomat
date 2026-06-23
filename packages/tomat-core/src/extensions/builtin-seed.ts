// First-boot seeding of the built-in extension. On a fresh install the core
// install script places the extension files under the extensions dir; this registers
// + activates them (or falls back to the CDN, or the codebase in dev). A marker
// file records a successful seed so that after a user deletes the built-in it
// does NOT come back on the next boot.

import { join } from "@std/path";
import { errMessage } from "@tomat/shared";
import { paths } from "../paths.ts";
import { getLogger } from "../shared/log.ts";
import { type InstallEventSink, startDownload, startInstallDeps } from "./installer.ts";
import { BUILTIN_EXTENSION_ID, loadBuiltinExtensionManifest } from "./builtin-manifest.ts";
import { extensionsRegistry } from "./registry.ts";
import { requireWorkerDeno } from "../sidecars/worker-deno.ts";
import { memoriesStore } from "../services/memories-store.ts";

const log = getLogger("builtin-seed");

const NOOP_SINK: InstallEventSink = { log: () => {}, done: () => {} };

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

export async function seedBuiltinExtensionIfNeeded(sink: InstallEventSink): Promise<void> {
  if (await isSeeded()) {
    // Already seeded (or the user deleted it). Refresh the files when a newer
    // built-in version shipped, so an existing install isn't silently stuck
    // on the old toolset after an app update adds tools.
    await refreshBuiltinIfOutdated();
    return;
  }
  if (extensionsRegistry().get(BUILTIN_EXTENSION_ID)) {
    // Present already (downloaded by a prior boot, or installed manually): just
    // record the seed so a later user delete isn't undone on the next boot.
    await recordSeeded();
    return;
  }

  // First boot: DOWNLOAD the built-in only, leaving it at status 'downloaded'.
  // We deliberately do NOT auto-install its deps: installing needs the deno
  // worker runtime (which may not be downloaded yet this early in boot), and -
  // like every other extension - Install + per-tool Enable are explicit user
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
      {
        source: "builtin",
        preferLocalDir: join(paths().extensionsDir, BUILTIN_EXTENSION_ID),
      },
      wrapped,
    );
  } catch (err) {
    // A user-triggered install/update for the built-in may already hold the
    // per-extension lock; let that one win rather than failing boot seeding.
    log.warn(`built-in seed skipped: ${errMessage(err)}`);
  }
}

/** Once the deno worker runtime is available, finish installing the built-in
 *  (Phase-2 deps) and enable its tools + memories by default, so a fresh
 *  install works out of the box. Unlike third-party extensions (Install + Enable
 *  are explicit there), the built-in is the starter set the user already
 *  consented to by installing tomat. Idempotent: a no-op once installed; safe to
 *  call on boot and again on the deno-binary-ready signal. */
export async function autoInstallBuiltinIfReady(sink: InstallEventSink = NOOP_SINK): Promise<void> {
  const builtin = extensionsRegistry().get(BUILTIN_EXTENSION_ID);
  if (!builtin) return; // not seeded yet; seedBuiltinExtensionIfNeeded runs first
  if (builtin.status === "installed") {
    enableBuiltinDefaults();
    return;
  }
  if (builtin.status !== "downloaded") return; // drift: leave for the user
  try {
    await requireWorkerDeno();
  } catch {
    return; // deno not present yet; the onBinaryInstalled hook retries
  }
  const wrapped: InstallEventSink = {
    log: (jobId, id, stream, line) => sink.log(jobId, id, stream, line),
    done: (jobId, id, ok, code) => {
      sink.done(jobId, id, ok, code);
      if (ok) enableBuiltinDefaults();
    },
  };
  try {
    startInstallDeps(BUILTIN_EXTENSION_ID, wrapped);
  } catch (err) {
    // A concurrent user-triggered install holds the lock; let it win.
    log.warn(`built-in auto-install skipped: ${errMessage(err)}`);
  }
}

/** Turn on every built-in tool and memory (default-on for the starter set).
 *  Runtime permission prompts still gate what tools actually do. */
function enableBuiltinDefaults(): void {
  try {
    for (const t of extensionsRegistry().listTools(BUILTIN_EXTENSION_ID)) {
      if (!t.enabled) {
        extensionsRegistry().setToolEnabled(BUILTIN_EXTENSION_ID, t.name, true);
      }
    }
    for (const m of memoriesStore().list()) {
      if (m.provider === BUILTIN_EXTENSION_ID && !m.enabled) {
        memoriesStore().setEnabled(m.id, true);
      }
    }
  } catch (err) {
    log.warn(`enable built-in defaults failed: ${errMessage(err)}`);
  }
}

/** Detect (but do NOT auto-download) a newer built-in version. The cheap,
 *  signed manifest version check runs on boot; the tarball fetch is deferred to
 *  an explicit user action, since a download is never a silent boot side effect.
 *  The client's POST /extensions/check-updates reports the available update and the
 *  user triggers the download + install via the normal extension update flow. A
 *  deleted built-in (no registry row) is left alone. */
async function refreshBuiltinIfOutdated(): Promise<void> {
  const installed = extensionsRegistry().get(BUILTIN_EXTENSION_ID);
  if (!installed) return; // user deleted it; don't resurrect
  let available: string;
  try {
    // force so a new release is detected past the cached manifest; in dev
    // this is ignored and resolves from the codebase.
    available = (await loadBuiltinExtensionManifest({ force: true })).version;
  } catch (err) {
    log.warn(`built-in version check failed; leaving install as-is: ${errMessage(err)}`);
    return;
  }
  if (available === installed.version) return;
  log.info(
    `built-in extension update available: ${installed.version} -> ${available} ` +
      `(update via the extension update flow)`,
  );
}
