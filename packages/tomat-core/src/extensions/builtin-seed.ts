// First-boot seeding of the built-in extension. On a fresh install the core
// install script plants the verified extension tarball AND its signed manifest
// under the extensions dir; this re-verifies them and installs OFFLINE - boot must
// never make a network request (the install-script phase did all the fetching).
// In dev the bytes come from the codebase. If the artifacts aren't planted, the
// built-in is left for the user to install via the (user-gated) extensions UI; we
// do not fetch on boot. A marker file records a successful seed so that after a
// user deletes the built-in it does NOT come back on the next boot.

import { join } from "@std/path";
import { errMessage } from "@tomat/shared";
import { channel, paths } from "../paths.ts";
import { getLogger } from "../shared/log.ts";
import { type InstallEventSink, startDownload, startInstallDeps } from "./installer.ts";
import { BUILTIN_EXTENSION_ID, readPlantedManifest } from "./builtin-manifest.ts";
import { extensionsRegistry } from "./registry.ts";
import { requireWorkerDeno } from "../sidecars/worker-deno.ts";
import { memoriesStore } from "../services/memories-store.ts";

// Install-script-planted artifacts, read on first boot for an offline install.
// Keep these filenames in sync with scripts/install/core.{sh,ps1}.
const PLANTED_TARBALL = ".tomat-builtin.tgz";
const PLANTED_MANIFEST = ".tomat-builtin.json";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

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
  // Already seeded (or the user deleted it): nothing to do on boot. Built-in
  // updates are detected only via the user-gated POST /extensions/check-updates,
  // never by a silent boot-time version fetch.
  if (await isSeeded()) return;
  if (extensionsRegistry().get(BUILTIN_EXTENSION_ID)) {
    // Present already (downloaded by a prior boot, or installed manually): just
    // record the seed so a later user delete isn't undone on the next boot.
    await recordSeeded();
    return;
  }

  // First boot: install the built-in (leaving it at status 'downloaded'). We
  // deliberately do NOT auto-install its deps here: installing needs the deno
  // worker runtime (which may not be downloaded yet this early in boot), and -
  // like every other extension - Install + per-tool Enable are explicit user
  // steps. The seed marker flips after success so a user who deletes the built-in
  // later doesn't get it re-seeded.
  const wrapped: InstallEventSink = {
    log: (jobId, id, stream, line) => sink.log(jobId, id, stream, line),
    done: (jobId, id, ok, code) => {
      sink.done(jobId, id, ok, code);
      if (ok) void recordSeeded();
    },
  };

  let spec: Parameters<typeof startDownload>[0] | null = null;
  if (channel() === "dev") {
    // Dev resolves the built-in from the codebase (no network, no plant).
    spec = { source: "builtin" };
  } else {
    // Production: install ONLY from the install-script-planted artifacts, fully
    // offline. Read + verify the planted signed manifest, then hand it (with the
    // tarball path) to the installer. If either is missing, leave the built-in for
    // the user to install via the (user-gated) extensions UI rather than fetch.
    const tarballPath = join(paths().extensionsDir, PLANTED_TARBALL);
    const manifest = await readPlantedManifest(join(paths().extensionsDir, PLANTED_MANIFEST));
    if (manifest && (await fileExists(tarballPath))) {
      spec = { source: "builtin", planted: { tarballPath, manifest } };
    } else {
      log.info("built-in not planted for offline seed; deferring to user-gated install");
      return;
    }
  }

  try {
    startDownload(spec, wrapped);
  } catch (err) {
    // A user-triggered install/update for the built-in may already hold the
    // per-extension lock; let that one win rather than failing boot seeding.
    log.warn(`built-in seed skipped: ${errMessage(err)}`);
  }
}

// In-memory request to install the built-in once the deno worker runtime lands.
// Set when the user says "yes" in the install prompt but the runtime isn't
// downloaded yet; consumed by the onBinaryInstalled("deno") hook. Intentionally
// not persisted: a Core restart clears it, so the prompt drives a fresh request.
let builtinInstallQueued = false;

/** Start the built-in's Phase-2 deps install and enable its tools + memories on
 *  success. Caller must have confirmed status is 'downloaded' and the deno
 *  worker runtime is present. */
function startBuiltinInstall(sink: InstallEventSink): void {
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
    log.warn(`built-in install skipped: ${errMessage(err)}`);
  }
}

/** Install the built-in's tools (Phase-2 deps) at the user's explicit request,
 *  made from the Tools prompt. If the deno worker runtime is already present the
 *  install starts now; otherwise the request is queued in memory and runs once
 *  the runtime lands (`runQueuedBuiltinInstall`). Returns whether it was queued
 *  so the caller can tell the user the install is pending the runtime download.
 *  Idempotent: a no-op (and not queued) when already installed or in drift. */
export async function requestBuiltinInstall(
  sink: InstallEventSink = NOOP_SINK,
): Promise<{ queued: boolean }> {
  const builtin = extensionsRegistry().get(BUILTIN_EXTENSION_ID);
  if (!builtin) return { queued: false }; // not present (deleted / not seeded)
  if (builtin.status === "installed") {
    enableBuiltinDefaults();
    return { queued: false };
  }
  if (builtin.status !== "downloaded") return { queued: false }; // drift: leave it
  try {
    await requireWorkerDeno();
  } catch {
    builtinInstallQueued = true; // runtime absent: install once it lands
    return { queued: true };
  }
  startBuiltinInstall(sink);
  return { queued: false };
}

/** Run a queued built-in install once the deno worker runtime is available
 *  (called from the onBinaryInstalled("deno") hook). A no-op unless the user
 *  previously asked to install while the runtime was still missing. */
export async function runQueuedBuiltinInstall(sink: InstallEventSink = NOOP_SINK): Promise<void> {
  if (!builtinInstallQueued) return;
  builtinInstallQueued = false;
  const builtin = extensionsRegistry().get(BUILTIN_EXTENSION_ID);
  if (!builtin || builtin.status !== "downloaded") return; // gone / already done
  try {
    await requireWorkerDeno();
  } catch {
    builtinInstallQueued = true; // still not ready; wait for the next signal
    return;
  }
  startBuiltinInstall(sink);
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
