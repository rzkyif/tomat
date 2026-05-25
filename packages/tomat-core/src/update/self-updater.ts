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
// On Windows, the running .exe can't be replaced directly; the updater
// renames the old binary to `<name>.exe.old` first and deletes it on next start.

import { verifyAsync } from "@noble/ed25519";
import { join } from "@std/path";
import type { CoreManifest, ErrorCode } from "@tomat/shared";
import { CORE_MANIFEST_URL, CORE_VERSION } from "../config.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { binPath } from "../paths.ts";
import { binaryName, hostTriple, platformExe } from "../binaries/versions.ts";
import signingKeys from "../../data/signing-keys.json" with { type: "json" };
import { writeUpdateMarker } from "./rollback.ts";
import { loadCoreSettings } from "../services/core-settings.ts";

const log = getLogger("update");

export type UpdateEvent =
  | { kind: "staged"; version: string }
  | { kind: "error"; code: ErrorCode; message: string };

const updateSubscribers = new Set<(e: UpdateEvent) => void>();

export function subscribeUpdate(
  cb: (e: UpdateEvent) => void,
): () => void {
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
      log.warn(
        `update subscriber threw: ${err instanceof Error ? err.message : err}`,
      );
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
    manifestUrl: CORE_MANIFEST_URL,
  };
}

export async function applyUpdate(targetVersion?: string): Promise<void> {
  try {
    await applyUpdateInner(targetVersion);
  } catch (err) {
    if (err instanceof AppError) {
      emitUpdate({ kind: "error", code: err.code, message: err.message });
    } else {
      const message = err instanceof Error ? err.message : String(err);
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
  // Refuse downgrades unless the operator has explicitly opted in via the
  // `updates.allowDowngrade` core setting. The manifest is signed
  // (verified upstream of this call) but a compromised signing key OR a
  // roll-back of the published manifest is still possible. Without this
  // guard, a downgrade could re-introduce a fixed vulnerability.
  if (compareSemver(manifest.version, CORE_VERSION) < 0) {
    const settings = await loadCoreSettings();
    const allowDowngrade = settings["updates.allowDowngrade"] === true;
    if (!allowDowngrade) {
      throw new AppError(
        "update_failed",
        `refusing downgrade: manifest v${manifest.version} is older than ` +
          `running v${CORE_VERSION}. ` +
          `Set "updates.allowDowngrade": true in core settings to override.`,
      );
    }
    log.warn(
      `installing downgrade v${CORE_VERSION} → v${manifest.version} ` +
        `(allowed via updates.allowDowngrade setting)`,
    );
  }
  const triple = hostTriple();
  const entry = manifest.binaries.find((b) => b.triple === triple);
  if (!entry) {
    throw new AppError(
      "update_failed",
      `no binary for triple ${triple} in manifest`,
    );
  }
  await Deno.mkdir(paths().stagingDir, { recursive: true });
  const stagedPath = join(
    paths().stagingDir,
    `tomat-core-${manifest.version}${exeSuffix()}`,
  );
  await downloadAndVerify(entry.url, stagedPath, entry.sha256);

  // Workers are platform-independent .ts files. Download + verify each,
  // then atomic-rename into paths().workersDir. They're not gated on the
  // binary swap because they're just text — a new binary doesn't break
  // old workers and vice versa (the spawn protocol is stable).
  if (manifest.workers && manifest.workers.length > 0) {
    await Deno.mkdir(paths().workersDir, { recursive: true });
    for (const w of manifest.workers) {
      const tmpPath = join(paths().stagingDir, `${w.name}.${manifest.version}`);
      await downloadAndVerify(w.url, tmpPath, w.sha256);
      const dstPath = join(paths().workersDir, w.name);
      await Deno.rename(tmpPath, dstPath);
      log.info(`updated worker ${w.name}`);
    }
  }

  // Helpers are per-triple native binaries (keychain). Only the
  // entries matching our triple apply. Swap them at the same time as the
  // main binary to keep version invariants — the manifest is one atomic
  // unit, and a stale helper paired with a new core has no version pinning.
  if (manifest.helpers && manifest.helpers.length > 0) {
    const exe = platformExe();
    for (const h of manifest.helpers) {
      if (h.triple !== triple) continue;
      const tmpPath = join(
        paths().stagingDir,
        `${h.name}.${manifest.version}${exe}`,
      );
      await downloadAndVerify(h.url, tmpPath, h.sha256);
      const dstPath = binPath(`${h.name}${exe}`);
      await Deno.rename(tmpPath, dstPath);
      log.info(`updated helper ${h.name}`);
    }
  }

  const currentBin = binPath(binaryName("tomat-core" as unknown as never));
  const updaterBin = binPath(
    binaryName("tomat-core-updater" as unknown as never),
  );

  // Hand off and exit. The updater is a separate compiled binary; if it
  // doesn't exist yet (early dev), we surface a clear error so the user
  // knows the updater needs to be built/shipped alongside core.
  try {
    await Deno.stat(updaterBin);
  } catch {
    throw new AppError(
      "update_failed",
      `tomat-core-updater not installed at ${updaterBin}; ` +
        `rebuild + ship the updater binary or run the install script`,
    );
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
    res = await fetch(CORE_MANIFEST_URL);
  } catch (err) {
    throw new AppError(
      "manifest_fetch_failed",
      `core manifest fetch failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!res.ok) {
    throw new AppError(
      "manifest_fetch_failed",
      `core manifest HTTP ${res.status} ${res.statusText}`,
    );
  }
  const raw = await res.text();
  const parsed = JSON.parse(raw) as CoreManifest;
  if (parsed.schemaVersion !== 1) {
    throw new AppError(
      "manifest_fetch_failed",
      `bad core manifest schemaVersion`,
    );
  }
  const pk = decodeBase64(signingKeys.publicKey);
  const sig = decodeBase64(parsed.signature);
  const body = new TextEncoder().encode(
    canonicalize({ version: parsed.version, binaries: parsed.binaries }),
  );
  const ok = await verifyAsync(sig, body, pk);
  if (!ok) {
    throw new AppError("signature_invalid", "core manifest signature invalid");
  }
  return parsed;
}

async function downloadAndVerify(
  url: string,
  outPath: string,
  sha256: string,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new AppError(
      "update_failed",
      `download HTTP ${res.status} for ${url}`,
    );
  }
  const tmp = outPath + ".tmp";
  const file = await Deno.open(tmp, {
    create: true,
    write: true,
    truncate: true,
  });
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of res.body) {
      chunks.push(chunk);
      await file.write(chunk);
    }
  } finally {
    file.close();
  }
  const merged = mergeChunks(chunks);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    merged.buffer as ArrayBuffer,
  );
  const hex = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  if (hex !== sha256.toLowerCase()) {
    try {
      await Deno.remove(tmp);
    } catch { /* */ }
    throw new AppError(
      "checksum_mismatch",
      `update sha256 mismatch: want ${sha256}, got ${hex}`,
    );
  }
  await Deno.rename(tmp, outPath);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(outPath, 0o755);
  }
}

function exeSuffix(): "" | ".exe" {
  return Deno.build.os === "windows" ? ".exe" : "";
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Deterministic JSON serializer (sorted keys, recursive). The signed body
 *  of a manifest is the canonicalization of `{ version, binaries }`, so the
 *  exact key/whitespace order has to match between signer and verifier. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}";
}

/** Compare two semver strings (major.minor.patch). Returns -1 if a < b,
 *  0 if equal, 1 if a > b. Pre-release tags and build metadata are
 *  ignored — sufficient for downgrade detection where the manifest publishes
 *  release versions only. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const core = v.split(/[-+]/)[0]; // drop prerelease + build
    const parts = core.split(".").map((p) => parseInt(p, 10));
    return [
      Number.isFinite(parts[0]) ? parts[0] : 0,
      Number.isFinite(parts[1]) ? parts[1] : 0,
      Number.isFinite(parts[2]) ? parts[2] : 0,
    ];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}
