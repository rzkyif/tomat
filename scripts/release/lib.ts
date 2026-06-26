// Shared helpers for the release task family.
//
// Anything that touches .env, paths, signing, R2 uploads, or fetches lives
// here. Sub-scripts (core.ts, client.ts, install-scripts.ts, schemas.ts,
// website.ts) compose these helpers; main.ts imports each sub-script's
// main() to run the umbrella release.

import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { copy } from "@std/fs/copy";
import { ensureDir } from "@std/fs/ensure-dir";
import { walk } from "@std/fs/walk";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { load as loadDotenv } from "@std/dotenv";
import * as ed from "@noble/ed25519";
import { canonicalize } from "../../packages/tomat-shared/src/crypto/canonical.ts";

// ---------------------------------------------------------------------------
// paths

export const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../..");
export const WEBSITE_DIR = join(REPO_ROOT, "packages/tomat-website");
export const CORE_DIR = join(REPO_ROOT, "packages/tomat-core");
export const SHARED_DIR = join(REPO_ROOT, "packages/tomat-shared");
export const INSTALL_DIR = join(REPO_ROOT, "scripts/install");
export const DIST_DIR = join(REPO_ROOT, "dist");
export const ENV_PATH = join(REPO_ROOT, ".env");
export const ENV_EXAMPLE_PATH = join(REPO_ROOT, ".env.example");
export const SIGNING_KEYS_PATH = join(CORE_DIR, "data/signing-keys.json");
export const CONFIG_PATH = join(CORE_DIR, "src/config.ts");

// ---------------------------------------------------------------------------
// pretty output

export const colors = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export function step(name: string): void {
  console.log("\n" + colors.bold(colors.cyan(`▸ ${name}`)));
}

export function info(msg: string): void {
  console.log(colors.dim("  ") + msg);
}

export function ok(msg: string): void {
  console.log(colors.dim("  ") + colors.green("✓") + " " + msg);
}

export function fail(msg: string): never {
  console.error(colors.red(`error: ${msg}`));
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// file utils

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyFile(src: string, dst: string): Promise<void> {
  await ensureDir(dirname(dst));
  await copy(src, dst, { overwrite: true });
}

export function rel(p: string): string {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return {
    sha256: encodeHex(new Uint8Array(digest)),
    size: data.byteLength,
  };
}

export async function sha256String(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data.buffer);
  return encodeHex(new Uint8Array(digest));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// .env handling

export interface DeployEnv {
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  websiteDomain: string;
  storageDomain: string;
  r2Bucket: string;
  /** Raw text of the Tauri updater keys (minisign format). Empty when the
   *  user hasn't set up client updates yet. The release orchestrator skips the
   *  client item with a yellow warning when these are missing. */
  tauriUpdaterPublicKey: string;
  tauriUpdaterPrivateKey: string;
  tauriUpdaterPassword: string;
  /** Android release keystore (base64 of the .jks) + its passwords/alias. Empty
   *  when the user hasn't set up Android signing yet; the release orchestrator
   *  skips the android item with a yellow warning when the keystore is missing.
   *  Unlike the desktop client, the APK is not self-update-signed by Tauri (the
   *  updater plugin has no Android support); the keystore signs the APK for
   *  install and the Ed25519 signingPrivateKey signs android.json. */
  androidKeystoreB64: string;
  androidKeystorePassword: string;
  androidKeyAlias: string;
  androidKeyPassword: string;
}

export async function loadOrSeedEnv(): Promise<DeployEnv> {
  if (!(await exists(ENV_PATH))) {
    if (!(await exists(ENV_EXAMPLE_PATH))) {
      fail(`neither .env nor .env.example found at ${REPO_ROOT}`);
    }
    info(`.env missing; seeding from .env.example`);
    await copyFile(ENV_EXAMPLE_PATH, ENV_PATH);
  }

  const raw = await loadDotenv({ envPath: ENV_PATH, export: false });
  const get = (k: string) => raw[k] ?? "";

  let privB64 = get("TOMAT_SIGNING_PRIVATE_KEY_B64");
  let pubB64 = get("TOMAT_SIGNING_PUBLIC_KEY_B64");

  if (!privB64 && !pubB64) {
    info(`generating new Ed25519 signing keypair`);
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    privB64 = encodeBase64(sk);
    pubB64 = encodeBase64(pk);
    await persistEnvKey("TOMAT_SIGNING_PRIVATE_KEY_B64", privB64);
    await persistEnvKey("TOMAT_SIGNING_PUBLIC_KEY_B64", pubB64);
    ok(`keypair written to .env`);
  } else if (!privB64 || !pubB64) {
    fail(
      `one half of the signing keypair is missing in .env. Either fill both ` +
        `or clear both (and re-run to generate)`,
    );
  } else {
    const sk = decodeBase64(privB64);
    const derivedPk = encodeBase64(await ed.getPublicKeyAsync(sk));
    if (derivedPk !== pubB64) {
      fail(
        `signing keypair in .env is mismatched: derived public key ` +
          `${derivedPk} != stored ${pubB64}`,
      );
    }
  }

  const tauriPub = get("TAURI_UPDATER_PUBLIC_KEY");
  const tauriPriv = get("TAURI_UPDATER_PRIVATE_KEY");
  if (tauriPub && !tauriPriv) {
    fail(
      `TAURI_UPDATER_PUBLIC_KEY is set but TAURI_UPDATER_PRIVATE_KEY is not. ` +
        `Either fill both or clear both. Re-generate via ` +
        `\`cargo tauri signer generate -w .env\`.`,
    );
  }

  return {
    signingPrivateKey: decodeBase64(privB64),
    signingPublicKey: decodeBase64(pubB64),
    websiteDomain: get("TOMAT_WEBSITE_DOMAIN") || "au.tomat.ing",
    storageDomain: get("TOMAT_STORAGE_DOMAIN") || "get.au.tomat.ing",
    r2Bucket: get("TOMAT_R2_BUCKET") || "tomat-releases",
    tauriUpdaterPublicKey: tauriPub,
    tauriUpdaterPrivateKey: tauriPriv,
    tauriUpdaterPassword: get("TAURI_UPDATER_PRIVATE_KEY_PASSWORD"),
    androidKeystoreB64: get("TOMAT_ANDROID_KEYSTORE_B64"),
    androidKeystorePassword: get("TOMAT_ANDROID_KEYSTORE_PASSWORD"),
    androidKeyAlias: get("TOMAT_ANDROID_KEY_ALIAS") || "upload",
    androidKeyPassword: get("TOMAT_ANDROID_KEY_PASSWORD") || get("TOMAT_ANDROID_KEYSTORE_PASSWORD"),
  };
}

/** In-place .env editor that preserves comments and ordering. Falls back to
 *  appending the key at the bottom if not present. */
export async function persistEnvKey(key: string, value: string): Promise<void> {
  const text = await Deno.readTextFile(ENV_PATH);
  const lines = text.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${value}`);
  await Deno.writeTextFile(ENV_PATH, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// signing-keys.json regeneration

export async function writeSigningKeys(publicKeyB64: string): Promise<void> {
  const json = JSON.stringify({ publicKey: publicKeyB64 }, null, 2) + "\n";
  await Deno.writeTextFile(SIGNING_KEYS_PATH, json);
  ok(`wrote public key to ${rel(SIGNING_KEYS_PATH)}`);
}

// ---------------------------------------------------------------------------
// item versions

export async function readCoreVersion(): Promise<string> {
  const text = await Deno.readTextFile(CONFIG_PATH);
  const match = text.match(/export\s+const\s+CORE_VERSION\s*=\s*"([^"]+)"/);
  if (!match) fail(`could not parse CORE_VERSION from ${rel(CONFIG_PATH)}`);
  return match[1];
}

/** Read the top-level `version` field from a JSON file (deno.json, the schema,
 *  scripts/install/version.json, …). Used by the versioned release items. */
export async function readVersionField(path: string): Promise<string> {
  const cfg = JSON.parse(await Deno.readTextFile(path)) as { version?: string };
  if (!cfg.version) fail(`no "version" field in ${rel(path)}`);
  return cfg.version;
}

// ---------------------------------------------------------------------------
// canonical JSON for signing. Single-sourced in @tomat/shared (imported above)
// so the signer here and the core verifiers (binaries/manifest.ts,
// update/self-updater.ts) recompute byte-identical bytes and can't drift.
export { canonicalize };

// ---------------------------------------------------------------------------
// host triple detection (same logic the install scripts use)

import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";

export function detectHostTriple(): Triple {
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  const arched = arch === "aarch64" ? "aarch64" : "x86_64";
  if (os === "darwin") return `${arched}-apple-darwin` as Triple;
  if (os === "linux") return `${arched}-unknown-linux-gnu` as Triple;
  if (os === "windows") return `${arched}-pc-windows-msvc` as Triple;
  fail(`unsupported host OS: ${os}`);
}

// ---------------------------------------------------------------------------
// release channels
//
// stable + latest are the only *published* channels (dev is local-only). The
// conventions mirror the runtime side (core paths.ts channelSuffix +
// config.ts manifestDir, client channel.rs): stable stays bare for
// back-compat; latest suffixes our binary names and nests manifests + artifacts
// under a /latest path segment.

export type ReleaseChannel = "stable" | "latest";

export function parseChannelFlag(value: string | undefined): ReleaseChannel {
  const ch = (value ?? "stable").trim() || "stable";
  if (ch !== "stable" && ch !== "latest") {
    fail(`invalid --channel: ${ch} (expected "stable" or "latest")`);
  }
  return ch;
}

/** Suffix on tomat's own binary names: "" for stable, "-latest" otherwise. */
export function channelBinSuffix(channel: ReleaseChannel): string {
  return channel === "stable" ? "" : `-${channel}`;
}

/** R2 manifest dir for this channel: "manifests" | "manifests/latest". */
export function channelManifestDir(channel: ReleaseChannel): string {
  return channel === "stable" ? "manifests" : `manifests/${channel}`;
}

/** R2 artifact key prefix before "<version>/<triple>/…": "" | "latest/". */
export function channelStoragePrefix(channel: ReleaseChannel): string {
  return channel === "stable" ? "" : `${channel}/`;
}

// ---------------------------------------------------------------------------
// astro + wrangler

export async function astroBuild(): Promise<void> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", "npm:astro@^6.4.4", "build"],
    cwd: WEBSITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`astro build exited ${code}`);
}

export async function wranglerDeploy(): Promise<void> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", "npm:wrangler@^4", "deploy"],
    cwd: WEBSITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`wrangler deploy exited ${code}`);
}

// ---------------------------------------------------------------------------
// R2 uploads

export async function r2Put(
  env: DeployEnv,
  key: string,
  file: string,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  const args = [
    "run",
    "-A",
    "npm:wrangler@^4",
    "r2",
    "object",
    "put",
    `${env.r2Bucket}/${key}`,
    "--file",
    file,
    "--content-type",
    contentType,
    "--remote",
  ];
  if (cacheControl) args.push("--cache-control", cacheControl);
  const cmd = new Deno.Command("deno", {
    args,
    cwd: WEBSITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`wrangler r2 put ${key} exited ${code}`);

  // Verify the upload actually landed AND matches byte-for-byte. Wrangler has a
  // bug where transient node TLS errors (`node:_tls_wrap: Uncaught TypeError:
  // this._handle.start is not a function`) crash a PUT mid-stream but still exit
  // 0, leaving the object missing or truncated. GET the public URL with a
  // cachebusting query param and compare sha256 (a Content-Length check alone
  // would pass a same-length corruption or count-preserving truncation).
  await verifyR2Upload(env, key, file);
}

async function verifyR2Upload(env: DeployEnv, key: string, file: string): Promise<void> {
  const url = `https://${env.storageDomain}/${key}?_v=${Date.now()}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    fail(`r2 put ${key}: post-upload GET failed: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok || !res.body) {
    fail(
      `r2 put ${key}: post-upload GET returned ${res.status} ${res.statusText}. ` +
        `Wrangler likely crashed mid-upload despite exit 0. Re-run the task.`,
    );
  }
  const remoteBytes = new Uint8Array(await res.arrayBuffer());
  const remoteHash = encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", remoteBytes.buffer as ArrayBuffer)),
  );
  const local = await sha256File(file);
  if (remoteBytes.byteLength !== local.size) {
    fail(
      `r2 put ${key}: size mismatch (local ${local.size}, remote ${remoteBytes.byteLength}). ` +
        `Re-run the task.`,
    );
  }
  if (remoteHash !== local.sha256) {
    fail(
      `r2 put ${key}: sha256 mismatch (local ${local.sha256}, remote ${remoteHash}). ` +
        `Re-run the task.`,
    );
  }
}

export async function r2PutInline(
  env: DeployEnv,
  key: string,
  body: string,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  const tmp = await Deno.makeTempFile({ prefix: "r2-inline-" });
  try {
    await Deno.writeTextFile(tmp, body);
    await r2Put(env, key, tmp, contentType, cacheControl);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// idempotency probes (HTTPS GETs against R2 / Worker)

/** GET an R2-hosted JSON at `https://${storageDomain}/${r2Key}`. Returns null
 *  on 404 (treated as "not yet published"). Throws on other non-2xx. */
export async function fetchLiveJson<T>(env: DeployEnv, r2Key: string): Promise<T | null> {
  return await fetchHttpsJson<T>(`https://${env.storageDomain}/${r2Key}`);
}

/** GET a JSON document at an arbitrary HTTPS URL. Returns null on 404. */
export async function fetchHttpsJson<T>(url: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    fail(`network error fetching ${url}: ${err instanceof Error ? err.message : err}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) fail(`fetch ${url} returned ${res.status} ${res.statusText}`);
  try {
    return (await res.json()) as T;
  } catch (err) {
    fail(`invalid JSON at ${url}: ${err instanceof Error ? err.message : err}`);
  }
}

/** GET an R2-hosted file body. Returns null on 404. Throws on other non-2xx. */
export async function fetchR2Bytes(env: DeployEnv, r2Key: string): Promise<Uint8Array | null> {
  const url = `https://${env.storageDomain}/${r2Key}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    fail(`network error fetching ${url}: ${err instanceof Error ? err.message : err}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) fail(`fetch ${url} returned ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// source hashing
//
// A release item's "is it different from production?" signal is a deterministic
// hash of its source inputs (files + directories), independent of any build
// artifact. The unified release records these per item in the release-state
// cursor (below) and diffs the local hash against the recorded one.

export interface HashInput {
  /** Absolute path to a file or directory to fold into the hash. */
  path: string;
  /** Skip files whose repo-relative path matches (e.g. tests, build output). */
  exclude?: (relPath: string) => boolean;
}

/** Stable sha256 over the sorted (repo-relative-path, file-sha256) pairs of
 *  every file reachable from `inputs`. Missing paths are skipped. */
export async function hashPaths(inputs: HashInput[]): Promise<string> {
  const entries: { path: string; sha: string }[] = [];
  for (const input of inputs) {
    if (!(await exists(input.path))) continue;
    const stat = await Deno.stat(input.path);
    if (stat.isFile) {
      const r = rel(input.path);
      if (input.exclude?.(r)) continue;
      entries.push({ path: r, sha: (await sha256File(input.path)).sha256 });
    } else if (stat.isDirectory) {
      for await (const e of walk(input.path, { includeDirs: false })) {
        const r = rel(e.path);
        if (input.exclude?.(r)) continue;
        entries.push({ path: r, sha: (await sha256File(e.path)).sha256 });
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return await sha256String(entries.map((e) => `${e.path}\t${e.sha}`).join("\n"));
}

// ---------------------------------------------------------------------------
// packages
//
// A "package" is a unit of development (a workspace member). PACKAGES is the
// release side's view of the same package list the root deno.json `workspace`
// array owns: each package's source dir and its manifest kind. Release items
// reference packages by id (their `packages` field) to declare what they are
// built from, and items whose source hash is exactly "each package's src +
// manifest" derive that hash here via packagesHashInputs.

export type PackageKind = "deno" | "rust";

export const PACKAGES: Record<string, { dir: string; kind: PackageKind }> = {
  shared: { dir: "packages/tomat-shared", kind: "deno" },
  core: { dir: "packages/tomat-core", kind: "deno" },
  client: { dir: "packages/tomat-client", kind: "deno" },
  website: { dir: "packages/tomat-website", kind: "deno" },
  extension: { dir: "packages/tomat-builtin", kind: "deno" },
  catalog: { dir: "packages/tomat-model-catalog", kind: "deno" },
  "core-updater": { dir: "packages/tomat-core-updater", kind: "rust" },
  "core-keychain": { dir: "packages/tomat-core-keychain", kind: "rust" },
  "core-hwinfo": { dir: "packages/tomat-core-hwinfo", kind: "rust" },
  "core-ptyhost": { dir: "packages/tomat-core-ptyhost", kind: "rust" },
  "core-speech": { dir: "packages/tomat-core-speech", kind: "rust" },
};

/** Source-hash inputs for one package: its source tree + its manifest. */
export function pkgHashInputs(id: string): string[] {
  const p = PACKAGES[id];
  if (!p) throw new Error(`unknown package id: ${id}`);
  const manifest = p.kind === "rust" ? "Cargo.toml" : "deno.json";
  return [`${p.dir}/src`, `${p.dir}/${manifest}`];
}

/** Combined source-hash inputs for a set of packages. Order-independent: the
 *  hash sorts paths globally, so [a, b] and [b, a] yield the same hash. */
export function packagesHashInputs(ids: string[]): string[] {
  return ids.flatMap(pkgHashInputs);
}

const WEBSITE_HASH_INPUTS = ["src", "public", "astro.config.mjs", "wrangler.toml"];

export async function hashWebsiteSource(): Promise<string> {
  return await hashPaths(
    WEBSITE_HASH_INPUTS.map((p) => ({
      path: join(WEBSITE_DIR, p),
      // A stale release-state.json from an older website build must not feed
      // back into the hash; the cursor lives on R2 now, not in public/.
      exclude: (r) => r.endsWith("release-state.json"),
    })),
  );
}

// ---------------------------------------------------------------------------
// semver compare (version-bump gate)

function parseSemver(v: string): [number, number, number] {
  const core = v.split("+")[0].split("-")[0];
  const parts = core.split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** True when `a` is a strictly higher version than `b` (major.minor.patch;
 *  pre-release/build metadata ignored). */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

// ---------------------------------------------------------------------------
// release-state cursor
//
// One tooling-only JSON on R2 recording each item's {version?, sourceHash} as
// of its last successful release. NEVER fetched or verified by core/client, so
// it carries no signature and has no Zod schema. Channel-specific items
// (core/extension/catalog/client) nest under channels.<channel>; the
// channel-independent items (scripts/schemas/website) live under `shared`.

export const RELEASE_STATE_KEY = "manifests/release-state.json";

export interface ItemState {
  version?: string;
  sourceHash: string;
}

export interface ReleaseCursor {
  schemaVersion: 1;
  channels: Record<string, Record<string, ItemState>>;
  shared: Record<string, ItemState>;
}

export async function readReleaseCursor(env: DeployEnv): Promise<ReleaseCursor> {
  const live = await fetchLiveJson<ReleaseCursor>(env, RELEASE_STATE_KEY);
  if (live && live.channels && live.shared) return live;
  return { schemaVersion: 1, channels: {}, shared: {} };
}

export async function writeReleaseCursor(env: DeployEnv, cursor: ReleaseCursor): Promise<void> {
  await r2PutInline(
    env,
    RELEASE_STATE_KEY,
    JSON.stringify(cursor, null, 2),
    "application/json",
    "public, max-age=60",
  );
}

// ---------------------------------------------------------------------------
// y/N confirmation

/** Reads a single y/N answer from the TTY. Returns true only on y / yes. */
export function promptYesNo(message: string): boolean {
  const ans = prompt(`${message} (y/N)`);
  return ans !== null && /^y(es)?$/i.test(ans.trim());
}

// ---------------------------------------------------------------------------
// release item contract
//
// Each module under scripts/release/ exports one ReleaseItem. The orchestrator
// (main.ts) computes sourceHash() to decide what changed, enforces the
// version-bump gate via version()/bumpHint, and calls apply() for changed
// items after confirmation.

export interface ApplyOpts {
  /** Triples to build (core/client). Other items ignore this. */
  triples: Triple[];
  /** Build + sign locally but skip every R2 upload. */
  dryRun: boolean;
}

export interface ReleaseItem {
  id: string;
  label: string;
  /** channel-specific items publish per channel; shared items publish once. */
  scope: "channel" | "shared";
  /** Package ids (keys of PACKAGES) this item is built from. A release item is
   *  a unit of distribution and may compose several packages (e.g. `core`).
   *  This is the explicit package -> release-item mapping; for items whose
   *  source hash is exactly "each package's src + manifest" it also derives the
   *  hash (see packagesHashInputs), so the package list cannot drift. */
  packages: string[];
  /** Where to bump the version when this item changed without a bump. */
  bumpHint?: string;
  /** Deterministic hash of this item's source inputs (no compiling). */
  sourceHash(channel: ReleaseChannel): Promise<string>;
  /** Current local version. */
  version(): Promise<string>;
  /** Extra "changed" signal beyond a source-hash diff (e.g. a client platform
   *  not yet published at the current version). Never gates a version bump. */
  extraChanged?(env: DeployEnv, channel: ReleaseChannel): Promise<boolean>;
  /** Absolute paths (files or dirs) this item compiles to. The unified
   *  `deno task build` hashes them so a wiped or swapped artifact forces a
   *  rebuild even when source is unchanged. Buildable items only. */
  buildOutputs?(channel: ReleaseChannel): Promise<string[]>;
  /** Build + sign + upload. Runs only for changed items, only after confirm. */
  apply(env: DeployEnv, channel: ReleaseChannel, opts: ApplyOpts): Promise<void>;
}

// ---------------------------------------------------------------------------
// signing convenience

export async function signEd25519(privateKey: Uint8Array, body: unknown): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalize(body)), privateKey);
  return encodeBase64(sig);
}

/** Detached Ed25519 signature over raw bytes (no canonicalization), base64.
 *  For a file an installer verifies exactly as downloaded (e.g. client.json.sig
 *  over the client.json bytes), where no shared canonicalizer is available. */
export async function signEd25519Bytes(privateKey: Uint8Array, bytes: Uint8Array): Promise<string> {
  return encodeBase64(await ed.signAsync(bytes, privateKey));
}
