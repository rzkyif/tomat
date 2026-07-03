// Core self-update.
//
// Flow:
//   1. Fetch the core update manifest from CORE_MANIFEST_URL.
//   2. Verify Ed25519 signature against the embedded core public key.
//   3. Pick the entry for the current triple, download to staging/, sha256-verify.
//   4. Spawn tomat-core-updater with arguments pointing at staging path + the
//      current bin path; updater waits 2s, renames atomic, restarts core.
//   5. Exit (the updater takes over).
//
// The updater preserves the previous binary as `<name>.old` on both platforms
// (Unix via a hard link before the atomic rename; Windows by renaming the old
// .exe aside) so core's boot-time rollback can restore it if the new binary
// crash-loops; the anchor is deleted once the update is committed.

import { verifyAsync } from "@noble/ed25519";
import { canonicalize, decodeBase64, errMessage } from "@tomat/shared";
import { join } from "@std/path";
import type { CoreManifest, ErrorCode } from "@tomat/shared";
import { CORE_VERSION, coreManifestUrl } from "../config.ts";
import { paths } from "../paths.ts";
import { AppError } from "@tomat/core-engine";
import { getLogger } from "../shared/log.ts";
import { compareSemver } from "../shared/semver.ts";
import { Sha256Stream } from "../shared/hash.ts";
import { binPath, channelBinName } from "../paths.ts";
import { coreBinaryName, hostTriple, platformExe } from "../binaries/versions.ts";
import signingKeys from "../../data/signing-keys.json" with { type: "json" };
import { writeUpdateMarker } from "./rollback.ts";

const log = getLogger("update");

export type UpdateEvent =
  | { kind: "staged"; version: string }
  | { kind: "error"; code: ErrorCode; message: string };

const updateSubscribers = new Set<(e: UpdateEvent) => void>();

export function subscribeUpdate(cb: (e: UpdateEvent) => void): () => void {
  updateSubscribers.add(cb);
  return () => {
    updateSubscribers.delete(cb);
  };
}

export function emitUpdate(e: UpdateEvent): void {
  for (const cb of updateSubscribers) {
    try {
      cb(e);
    } catch (err) {
      log.warn(`update subscriber threw: ${errMessage(err)}`);
    }
  }
}

export function __resetUpdateSubscribersForTesting(): void {
  updateSubscribers.clear();
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  manifestUrl: string;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const manifest = await fetchCoreManifest();
  return {
    currentVersion: CORE_VERSION,
    latestVersion: manifest.version,
    available: manifest.version !== CORE_VERSION,
    manifestUrl: coreManifestUrl(),
  };
}

export async function applyUpdate(targetVersion?: string): Promise<void> {
  try {
    await applyUpdateInner(targetVersion);
  } catch (err) {
    if (err instanceof AppError) {
      emitUpdate({ kind: "error", code: err.code, message: err.message });
    } else {
      const message = errMessage(err);
      emitUpdate({ kind: "error", code: "update_failed", message });
    }
    throw err;
  }
}

async function applyUpdateInner(targetVersion?: string): Promise<void> {
  const manifest = await fetchCoreManifest();
  if (targetVersion && targetVersion !== manifest.version) {
    throw new AppError(
      "update_failed",
      `manifest version ${manifest.version} does not match requested ${targetVersion}`,
    );
  }
  // Refuse downgrades. The manifest is signed (verified upstream of this
  // call) but a compromised signing key OR a roll-back of the published
  // manifest is still possible, and a downgrade could re-introduce a fixed
  // vulnerability.
  if (compareSemver(manifest.version, CORE_VERSION) < 0) {
    throw new AppError(
      "update_failed",
      `refusing downgrade: manifest v${manifest.version} is older than ` +
        `running v${CORE_VERSION}`,
    );
  }
  const triple = hostTriple();
  const entry = manifest.binaries.find((b) => b.triple === triple);
  if (!entry) {
    throw new AppError("update_failed", `no binary for triple ${triple} in manifest`);
  }
  // Clear any artifacts a previously-failed/partial update left behind so
  // staging only ever holds the set we are about to verify (it never
  // accumulates). Safe: applyUpdateInner runs once then exits for the updater.
  await Deno.remove(paths().stagingDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(paths().stagingDir, { recursive: true });
  const stagedPath = join(
    paths().stagingDir,
    `${channelBinName("tomat-core")}-${manifest.version}${exeSuffix()}`,
  );
  await downloadAndVerify(entry.url, stagedPath, entry.sha256);

  // Download + verify EVERY worker/helper artifact into staging FIRST, recording
  // where each should land. The renames into the live directories happen only
  // after all have verified (just before the handoff). A mid-update failure
  // (network drop on artifact N) then leaves staging dirty but never half-installs
  // the manifest: the live workers/helpers stay consistent with the old binary
  // until the whole set is ready.
  const pendingRenames: Array<{ from: string; to: string; label: string }> = [];

  // Workers are platform-independent .ts files. A new binary doesn't break old
  // workers and vice versa (the spawn protocol is stable).
  if (manifest.workers && manifest.workers.length > 0) {
    await Deno.mkdir(paths().workersDir, { recursive: true });
    for (const w of manifest.workers) {
      const tmpPath = join(paths().stagingDir, `${w.name}.${manifest.version}`);
      await downloadAndVerify(w.url, tmpPath, w.sha256);
      pendingRenames.push({
        from: tmpPath,
        to: join(paths().workersDir, w.name),
        label: `worker ${w.name}`,
      });
    }
  }

  // Helpers are per-triple native binaries (keychain). Only the entries matching
  // our triple apply. Swapped at the same time as the main binary to keep
  // version invariants: the manifest is one atomic unit.
  if (manifest.helpers && manifest.helpers.length > 0) {
    const exe = platformExe();
    for (const h of manifest.helpers) {
      if (h.triple !== triple) continue;
      const tmpPath = join(paths().stagingDir, `${h.name}.${manifest.version}${exe}`);
      await downloadAndVerify(h.url, tmpPath, h.sha256);
      pendingRenames.push({
        from: tmpPath,
        to: binPath(`${h.name}${exe}`),
        label: `helper ${h.name}`,
      });
    }
  }

  const currentBin = binPath(coreBinaryName("tomat-core"));
  const updaterBin = binPath(coreBinaryName("tomat-core-updater"));

  // Hand off and exit. The updater is a separate compiled binary; if it
  // doesn't exist yet (early dev), we surface a clear error so the user
  // knows the updater needs to be built/shipped alongside core. Checked BEFORE
  // committing any rename, so a missing updater leaves the live dirs untouched.
  try {
    await Deno.stat(updaterBin);
  } catch {
    throw new AppError(
      "update_failed",
      `tomat-core-updater not installed at ${updaterBin}; ` +
        `rebuild + ship the updater binary or run the install script`,
    );
  }

  // Everything is staged + verified: commit the workers/helpers now, as close to
  // the binary handoff as possible to minimize the window where they could be
  // skewed against the running (old) binary.
  for (const r of pendingRenames) {
    await Deno.rename(r.from, r.to);
    log.info(`updated ${r.label}`);
  }

  // Write the rollback marker BEFORE handing off to the updater. The new
  // binary checks this on first boot; if it crashes before MARKER_TTL_MS,
  // the next boot detects the unchanged marker and rolls back.
  await writeUpdateMarker({
    version: manifest.version,
    previousVersion: CORE_VERSION,
  });

  const cmd = new Deno.Command(updaterBin, {
    args: [
      "--staged",
      stagedPath,
      "--current",
      currentBin,
      "--restart-args",
      JSON.stringify(Deno.args),
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  cmd.spawn();
  emitUpdate({ kind: "staged", version: manifest.version });

  log.info(`update staged at ${stagedPath}; exiting for updater takeover`);
  // Give the updater a beat to detach.
  await new Promise((r) => setTimeout(r, 200));
  Deno.exit(0);
}

// --- internals ------------------------------------------------------------

async function fetchCoreManifest(): Promise<CoreManifest> {
  let res: Response;
  try {
    res = await fetch(coreManifestUrl());
  } catch (err) {
    throw new AppError("manifest_fetch_failed", `core manifest fetch failed: ${errMessage(err)}`);
  }
  if (!res.ok) {
    throw new AppError(
      "manifest_fetch_failed",
      `core manifest HTTP ${res.status} ${res.statusText}`,
    );
  }
  const raw = await res.text();
  let parsed: CoreManifest;
  try {
    parsed = JSON.parse(raw) as CoreManifest;
  } catch (err) {
    throw new AppError("manifest_fetch_failed", `invalid core manifest JSON: ${errMessage(err)}`);
  }
  // Validate the shape before touching any field (mirrors the binary-manifest
  // verifier), so a hostile/garbled response can't reach decodeBase64/verify
  // with an undefined signature and throw unwrapped.
  assertCoreManifestShape(parsed);
  const pk = decodeBase64(signingKeys.publicKey);
  const sig = decodeBase64(parsed.signature);
  const body = new TextEncoder().encode(
    signedManifestPayload(parsed as unknown as Record<string, unknown>),
  );
  const ok = await verifyAsync(sig, body, pk);
  if (!ok) {
    throw new AppError("signature_invalid", "core manifest signature invalid");
  }
  return parsed;
}

/** Validate a fetched core manifest's shape before any field is read or the
 *  signature is verified. Mirrors `assertManifestShape` in binaries/manifest.ts
 *  so the three trust-root fetchers behave identically on a garbled response. */
function assertCoreManifestShape(value: unknown): asserts value is CoreManifest {
  if (!value || typeof value !== "object") {
    throw new AppError("manifest_fetch_failed", "core manifest is not an object");
  }
  const o = value as Record<string, unknown>;
  if (o.schemaVersion !== 1) {
    throw new AppError("manifest_fetch_failed", "bad core manifest schemaVersion");
  }
  if (typeof o.signature !== "string" || o.signature.length === 0) {
    throw new AppError("manifest_fetch_failed", "core manifest missing signature");
  }
  if (typeof o.version !== "string" || o.version.length === 0) {
    throw new AppError("manifest_fetch_failed", "core manifest missing version");
  }
  if (!Array.isArray(o.binaries)) {
    throw new AppError("manifest_fetch_failed", "core manifest binaries is not an array");
  }
  for (const key of ["workers", "helpers"] as const) {
    if (o[key] !== undefined && !Array.isArray(o[key])) {
      throw new AppError("manifest_fetch_failed", `core manifest ${key} is not an array`);
    }
  }
}

async function downloadAndVerify(url: string, outPath: string, sha256: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new AppError("update_failed", `download HTTP ${res.status} for ${url}`);
  }
  // Core artifacts (binary, workers, helpers) ship gzip-compressed; the manifest
  // sha256 is over the DECOMPRESSED file, so decompress the stream before
  // writing + hashing.
  const body = res.body.pipeThrough(new DecompressionStream("gzip"));
  const tmp = outPath + ".tmp";
  const file = await Deno.open(tmp, {
    create: true,
    write: true,
    truncate: true,
  });
  // Hash incrementally while streaming to disk: the artifact (the ~100MB core
  // binary, model-sized helpers) is never held in memory, only one chunk at a
  // time.
  const sha = new Sha256Stream();
  try {
    for await (const chunk of body) {
      await file.write(chunk);
      sha.update(chunk);
    }
  } finally {
    file.close();
  }
  const hex = await sha.hexDigest();
  if (hex !== sha256.toLowerCase()) {
    try {
      await Deno.remove(tmp);
    } catch {
      /* */
    }
    throw new AppError("checksum_mismatch", `update sha256 mismatch: want ${sha256}, got ${hex}`);
  }
  await Deno.rename(tmp, outPath);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(outPath, 0o755);
  }
}

function exeSuffix(): "" | ".exe" {
  return Deno.build.os === "windows" ? ".exe" : "";
}

// canonicalize + decodeBase64 are the signature-critical serializers,
// single-sourced in @tomat/shared (imported above for use here) so the signer
// and both verifiers can't drift. Re-exported so self-updater.test.ts can
// import them from this module.
export { canonicalize, decodeBase64 };

/** The exact bytes covered by the core-manifest signature: the whole manifest
 *  minus its `signature` field, canonicalized. The signer
 *  (`scripts/release/core.ts`) MUST sign the identical payload. Keeping this a
 *  single named function makes the coverage testable and prevents anyone
 *  narrowing it back to `{version, binaries}`, which would leave `workers[]`
 *  and `helpers[]` (downloaded and EXECUTED) outside the signature and open a
 *  tampered-manifest code-execution path. */
export function signedManifestPayload(manifest: Record<string, unknown>): string {
  const signed: Record<string, unknown> = { ...manifest };
  delete signed.signature;
  return canonicalize(signed);
}
