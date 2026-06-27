// Built-in extension manifest: fetch + Ed25519 signature verification, mirroring
// binaries/manifest.ts. The built-in extension is CDN-distributed (never on npm);
// this module resolves its latest version + tarball for the installer.
//
// Distribution only gets the extension's files into the extension folder and
// registers it (disabled, no grants). Trusting (granting permissions),
// installing its npm deps, and enabling are left to the user via the normal
// extension flow, so there is no dedicated dep-install or auto-grant step here.
//
// Dev runs from source: there is no published manifests/dev/extension.json, so the
// dev manifest is read from a file `deno task dev` regenerates on codebase change
// (and falls back to computing it in-code from the codebase). Its `version`
// carries a content hash so an edit to the codebase extension reads as an update.

import { verifyAsync } from "@noble/ed25519";
import { fromFileUrl, join } from "@std/path";
import { canonicalize, decodeBase64, errMessage } from "@tomat/shared";
import type { BuiltinExtensionManifest } from "@tomat/shared";
import { BUILTIN_EXTENSION_ID } from "@tomat/shared";
import { builtinExtensionManifestUrl } from "../config.ts";
import { channel, paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { compareSemver } from "../shared/semver.ts";
import { hashExtension } from "./hash.ts";
import signingKeys from "../../data/signing-keys.json" with { type: "json" };

export { BUILTIN_EXTENSION_ID };

const log = getLogger("builtin-manifest");
const SIG_ALGO_LABEL = "ed25519-base64";

export interface FetchOptions {
  force?: boolean;
  signal?: AbortSignal;
}

/** Absolute path of the in-repo built-in extension, resolved from this module's
 *  URL (cwd-independent). Used as the byte source + version source in dev. */
export function builtinCodebasePath(): string {
  // builtin-manifest.ts lives at packages/tomat-core/src/extensions/.
  return fromFileUrl(new URL("../../../tomat-builtin", import.meta.url));
}

export async function loadBuiltinExtensionManifest(
  opts: FetchOptions = {},
): Promise<BuiltinExtensionManifest> {
  if (channel() === "dev") return await devManifest();
  const cached = await readCachedManifest();
  if (cached && !opts.force) return cached;
  const fetched = await fetchAndVerify(opts.signal);
  // Refuse a strictly-older signed manifest than the cached one: a validly-
  // signed prior release could be replayed to roll the built-in extension back to
  // a version with a fixed issue. `version` is inside the signature.
  if (cached && compareSemver(fetched.version, cached.version) < 0) {
    log.warn(
      `refusing older built-in extension manifest v${fetched.version}; keeping cached v${cached.version}`,
    );
    return cached;
  }
  await writeCachedManifest(fetched);
  return fetched;
}

/** Dev manifest: the dev script regenerates it at the cache path on codebase
 *  change. If it isn't there yet, compute it in-code from the codebase so the
 *  first boot before the watcher writes still works. No signature in dev: the
 *  from-source build IS the trust anchor. */
async function devManifest(): Promise<BuiltinExtensionManifest> {
  try {
    const text = await Deno.readTextFile(manifestCachePath());
    const parsed = JSON.parse(text);
    assertManifestShape(parsed);
    return parsed;
  } catch {
    return await computeDevManifest();
  }
}

/** Compose a dev manifest from the codebase: version = `<pkgVersion>+dev.<hash8>`
 *  where the hash covers the extension's content, so any edit changes the version
 *  and reads as an update after a check. Exported so the dev script reuses the
 *  exact same computation. */
export async function computeDevManifest(): Promise<BuiltinExtensionManifest> {
  const dir = builtinCodebasePath();
  const pkgVersion = await readCodebaseVersion(dir);
  const contentHash = await hashExtension(dir);
  return {
    schemaVersion: 1,
    version: `${pkgVersion}+dev.${contentHash.slice(0, 8)}`,
    id: BUILTIN_EXTENSION_ID,
    tarballUrl: "",
    sha256: "",
    signature: "",
  };
}

async function readCodebaseVersion(dir: string): Promise<string> {
  try {
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      version?: string;
    };
    return cfg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function fetchAndVerify(signal?: AbortSignal): Promise<BuiltinExtensionManifest> {
  let res: Response;
  try {
    res = await fetch(builtinExtensionManifestUrl(), { signal });
  } catch (err) {
    throw new AppError(
      "manifest_fetch_failed",
      `failed to fetch built-in extension manifest: ${errMessage(err)}`,
    );
  }
  if (!res.ok) {
    throw new AppError(
      "manifest_fetch_failed",
      `built-in extension manifest HTTP ${res.status} ${res.statusText}`,
    );
  }
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AppError("manifest_fetch_failed", `invalid manifest JSON: ${errMessage(err)}`);
  }
  assertManifestShape(parsed);
  await verifyManifestSignature(parsed);
  return parsed;
}

export function assertManifestShape(value: unknown): asserts value is BuiltinExtensionManifest {
  if (!value || typeof value !== "object") {
    throw new AppError("manifest_fetch_failed", "manifest is not an object");
  }
  const o = value as Record<string, unknown>;
  if (o.schemaVersion !== 1) {
    throw new AppError(
      "manifest_fetch_failed",
      `unsupported schemaVersion: ${String(o.schemaVersion)}`,
    );
  }
  for (const k of ["version", "id", "tarballUrl", "sha256", "signature"] as const) {
    if (typeof o[k] !== "string") {
      throw new AppError("manifest_fetch_failed", `manifest missing ${k}`);
    }
  }
}

/** Verify a built-in extension manifest signature: Ed25519 over
 *  canonicalize(manifest without `signature`). Key-injectable + pure so it's
 *  unit-testable with a throwaway keypair. Exported for testing. */
export async function verifyBuiltinManifestSignature(
  manifest: BuiltinExtensionManifest,
  publicKey: Uint8Array,
): Promise<boolean> {
  const { signature, ...unsigned } = manifest;
  const sig = decodeBase64(signature);
  const message = new TextEncoder().encode(canonicalize(unsigned));
  return await verifyAsync(sig, message, publicKey);
}

async function verifyManifestSignature(m: BuiltinExtensionManifest): Promise<void> {
  const pk = decodeBase64(signingKeys.publicKey);
  const ok = await verifyBuiltinManifestSignature(m, pk);
  if (!ok) {
    throw new AppError(
      "signature_invalid",
      `built-in extension manifest signature (${SIG_ALGO_LABEL}) verification failed`,
    );
  }
}

/** Read a signed built-in manifest JSON planted on disk by the install script and
 *  verify its Ed25519 signature OFFLINE (no network). Returns null when the file is
 *  absent, malformed, or the signature does not verify. This lets first-boot seeding
 *  install the built-in from install-script-planted artifacts without a single
 *  network request - core never fetches on boot; the install-script phase (where
 *  network is fine) already fetched + verified these bytes. */
export async function readPlantedManifest(path: string): Promise<BuiltinExtensionManifest | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    assertManifestShape(parsed);
    await verifyManifestSignature(parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function readCachedManifest(): Promise<BuiltinExtensionManifest | null> {
  try {
    const text = await Deno.readTextFile(manifestCachePath());
    const parsed = JSON.parse(text);
    assertManifestShape(parsed);
    // Re-verify on every read; cache is a perf optimization, not a trust anchor.
    await verifyManifestSignature(parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedManifest(m: BuiltinExtensionManifest): Promise<void> {
  await Deno.mkdir(paths().cacheDir, { recursive: true });
  const tmp = manifestCachePath() + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(m));
  await Deno.rename(tmp, manifestCachePath());
}

export function manifestCachePath(): string {
  return join(paths().cacheDir, "builtin-manifest.json");
}
