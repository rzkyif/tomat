// Shared helpers for the release task family.
//
// Anything that touches .env, paths, signing, R2 uploads, or fetches lives
// here. Sub-scripts (core.ts, client.ts, install-scripts.ts, schemas.ts,
// website.ts) compose these helpers; main.ts imports each sub-script's
// main() to run the umbrella release.

import { encodeBase64 } from "jsr:@std/encoding@^1/base64";
import { encodeHex } from "jsr:@std/encoding@^1/hex";
import { copy } from "jsr:@std/fs@^1/copy";
import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { walk } from "jsr:@std/fs@^1/walk";
import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@^1";
import { load as loadDotenv } from "jsr:@std/dotenv@^0.225";
import * as ed from "jsr:@noble/ed25519@^2";

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
export const UPSTREAM_BINARIES_PATH = join(WEBSITE_DIR, "data/upstream-binaries.json");
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
   *  user hasn't set up client updates yet. release:client skips itself
   *  with a yellow warning when missing. */
  tauriUpdaterPublicKey: string;
  tauriUpdaterPrivateKey: string;
  tauriUpdaterPassword: string;
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
    const sk = ed.utils.randomPrivateKey();
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
// core version

export async function readCoreVersion(): Promise<string> {
  const text = await Deno.readTextFile(CONFIG_PATH);
  const match = text.match(/export\s+const\s+CORE_VERSION\s*=\s*"([^"]+)"/);
  if (!match) fail(`could not parse CORE_VERSION from ${rel(CONFIG_PATH)}`);
  return match[1];
}

// ---------------------------------------------------------------------------
// canonical JSON for signing

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

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
// stable + beta are the only *published* channels (dev is local-only). The
// conventions mirror the runtime side (core paths.ts channelSuffix +
// config.ts manifestDir, client channel.rs): stable stays bare for
// back-compat; beta suffixes our binary names and nests manifests + artifacts
// under a /beta path segment.

export type ReleaseChannel = "stable" | "beta";

export function parseChannelFlag(value: string | undefined): ReleaseChannel {
  const ch = (value ?? "stable").trim() || "stable";
  if (ch !== "stable" && ch !== "beta") {
    fail(`invalid --channel: ${ch} (expected "stable" or "beta")`);
  }
  return ch;
}

/** Suffix on tomat's own binary names: "" for stable, "-beta" otherwise. */
export function channelBinSuffix(channel: ReleaseChannel): string {
  return channel === "stable" ? "" : `-${channel}`;
}

/** R2 manifest dir for this channel: "manifests" | "manifests/beta". */
export function channelManifestDir(channel: ReleaseChannel): string {
  return channel === "stable" ? "manifests" : `manifests/${channel}`;
}

/** R2 artifact key prefix before "<version>/<triple>/…": "" | "beta/". */
export function channelStoragePrefix(channel: ReleaseChannel): string {
  return channel === "stable" ? "" : `${channel}/`;
}

// ---------------------------------------------------------------------------
// astro + wrangler

export async function astroBuild(): Promise<void> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", "npm:astro@^5", "build"],
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

  // Verify the upload actually landed. Wrangler has a bug where transient
  // node TLS errors (`node:_tls_wrap: Uncaught TypeError: this._handle.start
  // is not a function`) crash a PUT mid-stream but still exit 0, leaving the
  // object missing from R2. HEAD the public URL with a cachebusting query
  // param and confirm both status and Content-Length.
  const localSize = (await Deno.stat(file)).size;
  await verifyR2Upload(env, key, localSize);
}

async function verifyR2Upload(env: DeployEnv, key: string, expectedSize: number): Promise<void> {
  const url = `https://${env.storageDomain}/${key}?_v=${Date.now()}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD" });
  } catch (err) {
    fail(`r2 put ${key}: post-upload HEAD failed: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) {
    fail(
      `r2 put ${key}: post-upload HEAD returned ${res.status} ${res.statusText}. ` +
        `Wrangler likely crashed mid-upload despite exit 0. Re-run the task.`,
    );
  }
  const remoteSize = Number(res.headers.get("content-length") ?? "-1");
  if (remoteSize !== expectedSize) {
    fail(
      `r2 put ${key}: size mismatch (local ${expectedSize}, remote ${remoteSize}). ` +
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
// website source hashing (for release:website idempotency)

const WEBSITE_HASH_INPUTS = ["src", "public", "astro.config.mjs", "wrangler.toml"];

/** Path (relative to packages/tomat-website/) of the release-state cursor
 *  itself. Excluded from the hash so it doesn't feed back into the hash it
 *  records. */
export const WEBSITE_STATE_REL = "public/release-state.json";

export async function hashWebsiteSource(): Promise<string> {
  const root = WEBSITE_DIR;
  const entries: { path: string; sha: string }[] = [];
  for (const input of WEBSITE_HASH_INPUTS) {
    const fullPath = join(root, input);
    if (!(await exists(fullPath))) continue;
    const stat = await Deno.stat(fullPath);
    if (stat.isFile) {
      const r = relative(root, fullPath);
      entries.push({ path: r, sha: (await sha256File(fullPath)).sha256 });
    } else if (stat.isDirectory) {
      for await (const e of walk(fullPath, { includeDirs: false })) {
        const r = relative(root, e.path);
        if (r === WEBSITE_STATE_REL) continue;
        entries.push({ path: r, sha: (await sha256File(e.path)).sha256 });
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return await sha256String(entries.map((e) => `${e.path}\t${e.sha}`).join("\n"));
}

// ---------------------------------------------------------------------------
// signing convenience

export async function signEd25519(privateKey: Uint8Array, body: unknown): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalize(body)), privateKey);
  return encodeBase64(sig);
}
