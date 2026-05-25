#!/usr/bin/env -S deno run -A
// Deploys @tomat/website + compiled core binaries to Cloudflare.
//
// End state of a successful run:
//   - https://au.tomat.ing/                        — landing page
//   - https://au.tomat.ing/manifests/core.json     — signed self-update manifest
//   - https://au.tomat.ing/manifests/binaries.json — signed helper-binary manifest
//   - https://au.tomat.ing/install/core.{sh,ps1}   — install one-liners
//   - https://au.tomat.ing/schemas/tools-v1.json   — tools.json JSON Schema
//   - https://get.au.tomat.ing/<version>/<triple>/tomat-core(.exe)
//   - https://get.au.tomat.ing/<version>/<triple>/tomat-core-updater(.exe)
//
// One-time setup (see packages/tomat-website/README.md): `wrangler login`,
// `wrangler r2 bucket create tomat-releases`, attach `get.au.tomat.ing`
// custom domain to the bucket in the CF dashboard.
//
// Re-running is safe: artifacts overwrite, the signing keypair persists in
// `.env`, and a partial deploy can be resumed by re-running.
//
// Flags:
//   --triples=all                        cross-compile for every supported triple
//   --triples=aarch64-apple-darwin,...   comma-separated subset
//   --skip-build                         reuse dist/ from a prior run
//   --dry-run                            do everything locally; skip R2 + worker
//   --help
//
// Default is host-only — cross-compiling all triples bundles native modules
// from the wrong platforms into each output (Deno warns about this) and
// takes 10+ minutes. Run on a per-platform basis instead.

import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { load as loadDotenv } from "jsr:@std/dotenv@^0.225";
import { encodeBase64 } from "jsr:@std/encoding@^1/base64";
import { encodeHex } from "jsr:@std/encoding@^1/hex";
import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { copy } from "jsr:@std/fs@^1/copy";
import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@^1";
import * as ed from "jsr:@noble/ed25519@^2";
import type {
  BinaryKind,
  BinaryManifest,
  BinaryManifestEntry,
  CoreManifest,
  Triple,
} from "../../packages/tomat-shared/src/domain/model.ts";
import { BINARY_KINDS } from "../../packages/tomat-shared/src/domain/model.ts";

// ---------------------------------------------------------------------------
// paths

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../..");
const WEBSITE_DIR = join(REPO_ROOT, "packages/tomat-website");
const CORE_DIR = join(REPO_ROOT, "packages/tomat-core");
const SHARED_DIR = join(REPO_ROOT, "packages/tomat-shared");
const INSTALL_DIR = join(REPO_ROOT, "scripts/install");
const DIST_DIR = join(REPO_ROOT, "dist");
const ENV_PATH = join(REPO_ROOT, ".env");
const ENV_EXAMPLE_PATH = join(REPO_ROOT, ".env.example");
const SIGNING_KEYS_PATH = join(CORE_DIR, "data/signing-keys.json");
const UPSTREAM_BINARIES_PATH = join(WEBSITE_DIR, "data/upstream-binaries.json");
const CONFIG_PATH = join(CORE_DIR, "src/config.ts");
const PUBLIC_DIR = join(WEBSITE_DIR, "public");

const ALL_TRIPLES: Triple[] = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
];

// Worker .ts files shipped alongside the binary (platform-independent).
// These are NOT bundled into the core binary — at runtime, the core spawns
// them as Deno subprocesses from ~/.tomat/core/workers/. Their npm deps
// (transformers, kokoro, onnxruntime) download lazily on first use.
const WORKER_FILES = [
  "embedding-worker.ts",
  "tool-worker.ts",
  "tts-worker.ts",
] as const;

// ---------------------------------------------------------------------------
// pretty output

const colors = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function step(name: string): void {
  console.log("\n" + colors.bold(colors.cyan(`▸ ${name}`)));
}

function info(msg: string): void {
  console.log(colors.dim("  ") + msg);
}

function ok(msg: string): void {
  console.log(colors.dim("  ") + colors.green("✓") + " " + msg);
}

function fail(msg: string): never {
  console.error(colors.red(`error: ${msg}`));
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// args

interface Flags {
  triples: Triple[];
  skipBuild: boolean;
  dryRun: boolean;
}

function parseFlags(): Flags {
  const args = parseArgs(Deno.args, {
    string: ["triples"],
    boolean: ["skip-build", "dry-run", "help"],
    default: { "skip-build": false, "dry-run": false, "help": false },
  });
  if (args.help) {
    printHelp();
    Deno.exit(0);
  }
  let triples: Triple[];
  if (!args.triples || args.triples === "host") {
    triples = [Deno.build.target as Triple];
  } else if (args.triples === "all") {
    triples = ALL_TRIPLES;
  } else {
    const requested = args.triples.split(",").map((t) => t.trim());
    for (const t of requested) {
      if (!(ALL_TRIPLES as readonly string[]).includes(t)) {
        fail(`unknown triple "${t}". Valid: ${ALL_TRIPLES.join(", ")}`);
      }
    }
    triples = requested as Triple[];
  }
  return {
    triples,
    skipBuild: args["skip-build"],
    dryRun: args["dry-run"],
  };
}

function printHelp(): void {
  console.log(`Usage: deno task website:deploy [flags]

Flags:
  --triples=<list>   comma-separated triples to build. Special values:
                       "host" (default) — current machine only
                       "all"            — every supported triple
                                          (${ALL_TRIPLES.join(", ")})
                     Cross-compiling pulls native modules from the host's
                     node_modules into binaries for other platforms, which
                     Deno warns about and which will misbehave at runtime.
                     Build each platform on its own machine for releases.
  --skip-build       reuse binaries in dist/ from a prior run
  --dry-run          skip R2 upload + wrangler deploy
  --help

The deploy script reads .env at the repo root. On first run it generates
the Ed25519 signing keypair and writes it back to .env.`);
}

// ---------------------------------------------------------------------------
// .env handling

interface DeployEnv {
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  cdnDomain: string;
  releasesDomain: string;
  r2Bucket: string;
  /** Raw text of the Tauri updater keys (minisign format). The deploy script
   *  injects the public key into tauri.conf.json and exports the private
   *  key as TAURI_SIGNING_PRIVATE_KEY when invoking `deno task build:client`.
   *  Empty when the user hasn't set up client updates yet — client build
   *  steps are skipped in that case. */
  tauriUpdaterPublicKey: string;
  tauriUpdaterPrivateKey: string;
  tauriUpdaterPassword: string;
}

async function loadOrSeedEnv(): Promise<DeployEnv> {
  // Seed .env from .env.example if missing.
  if (!(await exists(ENV_PATH))) {
    if (!(await exists(ENV_EXAMPLE_PATH))) {
      fail(`neither .env nor .env.example found at ${REPO_ROOT}`);
    }
    info(`.env missing — seeding from .env.example`);
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
    // Validate the pair: derive public from private, compare.
    const sk = decodeBase64(privB64);
    const derivedPk = encodeBase64(await ed.getPublicKeyAsync(sk));
    if (derivedPk !== pubB64) {
      fail(
        `signing keypair in .env is mismatched: derived public key ` +
          `${derivedPk} != stored ${pubB64}`,
      );
    }
    ok(`signing keypair loaded from .env`);
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
  if (!tauriPub) {
    info(
      colors.yellow(
        `tauri-plugin-updater keypair is not set in .env — client updates will ` +
          `not be packaged this run. Generate with \`cargo tauri signer generate -w .env\``,
      ),
    );
  } else {
    ok(`tauri updater keypair loaded from .env`);
  }

  return {
    signingPrivateKey: decodeBase64(privB64),
    signingPublicKey: decodeBase64(pubB64),
    cdnDomain: get("TOMAT_CDN_DOMAIN") || "au.tomat.ing",
    releasesDomain: get("TOMAT_RELEASES_DOMAIN") || "get.au.tomat.ing",
    r2Bucket: get("TOMAT_R2_BUCKET") || "tomat-releases",
    tauriUpdaterPublicKey: tauriPub,
    tauriUpdaterPrivateKey: tauriPriv,
    tauriUpdaterPassword: get("TAURI_UPDATER_PRIVATE_KEY_PASSWORD"),
  };
}

// In-place .env editor that preserves comments and ordering. Falls back to
// appending the key at the bottom if not present.
async function persistEnvKey(key: string, value: string): Promise<void> {
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

async function writeSigningKeys(publicKeyB64: string): Promise<void> {
  const json = JSON.stringify({ publicKey: publicKeyB64 }, null, 2) + "\n";
  await Deno.writeTextFile(SIGNING_KEYS_PATH, json);
  ok(`wrote public key to ${rel(SIGNING_KEYS_PATH)}`);
}

// ---------------------------------------------------------------------------
// core version

async function readCoreVersion(): Promise<string> {
  const text = await Deno.readTextFile(CONFIG_PATH);
  const match = text.match(/export\s+const\s+CORE_VERSION\s*=\s*"([^"]+)"/);
  if (!match) fail(`could not parse CORE_VERSION from ${rel(CONFIG_PATH)}`);
  return match[1];
}

// ---------------------------------------------------------------------------
// core + updater build

interface BuildArtifact {
  triple: Triple;
  name: "tomat-core" | "tomat-core-updater";
  path: string;
  sha256: string;
  size: number;
}

interface WorkerArtifact {
  name: string;
  path: string;
  sha256: string;
  size: number;
}

interface HelperArtifact {
  triple: Triple;
  name: "tomat-core-keychain";
  path: string;
  sha256: string;
  size: number;
}

const HELPER_CRATES: Array<
  { name: HelperArtifact["name"]; crateDir: string }
> = [
  {
    name: "tomat-core-keychain",
    crateDir: "packages/tomat-core-keychain",
  },
];

// Compiling from the live workspace bundles the whole shared
// node_modules / npm cache into the output (~2 GB). We sidestep that by
// creating a temp directory with symlinks to just `tomat-core` and
// `tomat-shared`, plus a minimal root `deno.json` that has no
// `nodeModulesDir` and no workspace siblings. Deno's TypeScript
// transpilation still works (it follows the symlinks), but the bundler
// only sees the two packages it needs. Final binary size drops from
// ~2.2 GB to ~94 MB.
async function setupCompileWorkspace(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tomat-compile-" });
  await Deno.mkdir(join(dir, "packages"));
  await Deno.symlink(
    join(REPO_ROOT, "packages/tomat-shared"),
    join(dir, "packages/tomat-shared"),
  );
  await Deno.symlink(
    join(REPO_ROOT, "packages/tomat-core"),
    join(dir, "packages/tomat-core"),
  );
  await Deno.symlink(
    join(REPO_ROOT, "packages/tomat-core-updater"),
    join(dir, "packages/tomat-core-updater"),
  );
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(
      {
        workspace: [
          "./packages/tomat-shared",
          "./packages/tomat-core",
          "./packages/tomat-core-updater",
        ],
        unstable: ["raw-imports"],
      },
      null,
      2,
    ),
  );
  return dir;
}

async function compileFor(
  triple: Triple,
  name: "tomat-core" | "tomat-core-updater",
  entryRelative: string,
  compileWorkspace: string,
): Promise<string> {
  const isWin = triple.includes("windows");
  const exe = isWin ? ".exe" : "";
  const outDir = join(DIST_DIR, triple);
  await ensureDir(outDir);
  const outPath = join(outDir, `${name}${exe}`);

  const cmd = new Deno.Command("deno", {
    args: [
      "compile",
      "--allow-all",
      "--target",
      triple,
      "--output",
      outPath,
      entryRelative,
    ],
    cwd: compileWorkspace,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`deno compile ${name} for ${triple} exited ${code}`);
  return outPath;
}

async function buildAll(
  triples: Triple[],
  skipBuild: boolean,
): Promise<BuildArtifact[]> {
  let compileWorkspace: string | null = null;
  try {
    const artifacts: BuildArtifact[] = [];
    for (const triple of triples) {
      const isWin = triple.includes("windows");
      const exe = isWin ? ".exe" : "";
      for (
        const [name, entryRelative] of [
          ["tomat-core", "packages/tomat-core/src/main.ts"],
          ["tomat-core-updater", "packages/tomat-core-updater/src/main.ts"],
        ] as const
      ) {
        const outPath = join(DIST_DIR, triple, `${name}${exe}`);
        if (skipBuild && (await exists(outPath))) {
          info(`reusing ${rel(outPath)}`);
        } else {
          if (!compileWorkspace) {
            compileWorkspace = await setupCompileWorkspace();
            info(`compile workspace at ${compileWorkspace}`);
          }
          info(`compiling ${name} for ${triple}`);
          await compileFor(triple, name, entryRelative, compileWorkspace);
        }
        const { sha256, size } = await hashAndSize(outPath);
        artifacts.push({ triple, name, path: outPath, sha256, size });
      }
    }
    return artifacts;
  } finally {
    if (compileWorkspace) {
      await Deno.remove(compileWorkspace, { recursive: true }).catch(() => {});
    }
  }
}

async function buildHelpers(
  triples: Triple[],
  skipBuild: boolean,
): Promise<HelperArtifact[]> {
  const out: HelperArtifact[] = [];
  for (const triple of triples) {
    const isWin = triple.includes("windows");
    const exe = isWin ? ".exe" : "";
    for (const { name, crateDir } of HELPER_CRATES) {
      const outDir = join(DIST_DIR, triple);
      await ensureDir(outDir);
      const outPath = join(outDir, `${name}${exe}`);
      if (skipBuild && (await exists(outPath))) {
        info(`reusing ${rel(outPath)}`);
      } else {
        info(`cargo build ${name} for ${triple}`);
        const cmd = new Deno.Command("cargo", {
          args: [
            "build",
            "--release",
            "--manifest-path",
            join(REPO_ROOT, crateDir, "Cargo.toml"),
            "--target",
            triple,
          ],
          stdout: "inherit",
          stderr: "inherit",
        });
        const { code } = await cmd.output();
        if (code !== 0) {
          fail(`cargo build ${name} for ${triple} exited ${code}`);
        }
        const builtPath = join(
          REPO_ROOT,
          crateDir,
          "target",
          triple,
          "release",
          `${name}${exe}`,
        );
        await Deno.copyFile(builtPath, outPath);
      }
      const { sha256, size } = await hashAndSize(outPath);
      out.push({ triple, name, path: outPath, sha256, size });
    }
  }
  return out;
}

async function hashWorkers(): Promise<WorkerArtifact[]> {
  const workersDir = join(CORE_DIR, "src/workers");
  const out: WorkerArtifact[] = [];
  for (const name of WORKER_FILES) {
    const path = join(workersDir, name);
    const { sha256, size } = await hashAndSize(path);
    out.push({ name, path, sha256, size });
  }
  return out;
}

async function hashAndSize(
  path: string,
): Promise<{ sha256: string; size: number }> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data.buffer as ArrayBuffer,
  );
  return {
    sha256: encodeHex(new Uint8Array(digest)),
    size: data.byteLength,
  };
}

// ---------------------------------------------------------------------------
// manifest assembly + signing

function canonicalize(value: unknown): string {
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

async function composeCoreManifest(
  version: string,
  artifacts: BuildArtifact[],
  workers: WorkerArtifact[],
  helpers: HelperArtifact[],
  releasesDomain: string,
  privateKey: Uint8Array,
): Promise<CoreManifest> {
  // Only tomat-core entries land in core.json — the updater is shipped as a
  // sibling but isn't itself selected by the self-update flow (self-updater
  // resolves the updater path from disk, not from the manifest).
  const binaries = artifacts
    .filter((a) => a.name === "tomat-core")
    .map((a) => ({
      triple: a.triple,
      url: `https://${releasesDomain}/${version}/${a.triple}/${
        binaryFilename("tomat-core", a.triple)
      }`,
      sha256: a.sha256,
    }));

  const workerEntries = workers.map((w) => ({
    name: w.name,
    url: `https://${releasesDomain}/${version}/workers/${w.name}`,
    sha256: w.sha256,
  }));

  const helperEntries = helpers.map((h) => ({
    name: h.name,
    triple: h.triple,
    url: `https://${releasesDomain}/${version}/${h.triple}/${
      binaryFilename(h.name, h.triple)
    }`,
    sha256: h.sha256,
  }));

  const body = {
    version,
    binaries,
    workers: workerEntries,
    helpers: helperEntries,
  };
  const sig = await ed.signAsync(
    new TextEncoder().encode(canonicalize(body)),
    privateKey,
  );
  return {
    schemaVersion: 1,
    version,
    binaries,
    workers: workerEntries,
    helpers: helperEntries,
    signature: encodeBase64(sig),
  };
}

function binaryFilename(name: string, triple: Triple): string {
  return triple.includes("windows") ? `${name}.exe` : name;
}

/** Resolver config schema from packages/tomat-website/data/upstream-binaries.json.
 *  Filename patterns may include `{tag}` which is replaced with the GitHub
 *  release's tag_name at fetch time. */
interface UpstreamResolver {
  repo: string;
  assets: Record<string, string>;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}
interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

async function fetchLatestRelease(repo: string): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "tomat-deploy",
  };
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  if (ghToken) headers.authorization = `Bearer ${ghToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    fail(
      `GitHub API ${res.status} for ${url}: ${await res.text().catch(() =>
        ""
      )}`,
    );
  }
  return await res.json() as GitHubRelease;
}

async function sha256OfUrl(url: string): Promise<string> {
  // Stream-hash so we don't buffer hundreds of MB in memory for the
  // (rare) case where llama.cpp ships large GPU builds.
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    fail(`could not fetch ${url} for SHA-256: ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  // Web Crypto SubtleCrypto wants a single buffer.
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return encodeHex(new Uint8Array(hash));
}

async function composeBinaryManifest(
  privateKey: Uint8Array,
): Promise<BinaryManifest> {
  const text = await Deno.readTextFile(UPSTREAM_BINARIES_PATH);
  let resolvers: Record<string, UpstreamResolver>;
  try {
    resolvers = JSON.parse(text) as Record<string, UpstreamResolver>;
  } catch (err) {
    fail(
      `${rel(UPSTREAM_BINARIES_PATH)} is not valid JSON: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  const binaries = {} as Record<BinaryKind, BinaryManifestEntry>;
  for (const kind of BINARY_KINDS) {
    const resolver = resolvers![kind];
    if (!resolver || !resolver.repo || !resolver.assets) {
      fail(
        `${rel(UPSTREAM_BINARIES_PATH)} missing/invalid entry for "${kind}"`,
      );
    }
    info(`resolving latest ${kind} from ${resolver.repo}`);
    const release = await fetchLatestRelease(resolver.repo);
    const tag = release.tag_name;
    info(`  latest tag: ${tag}`);

    const platforms: BinaryManifestEntry["platforms"] = {} as never;
    for (const [triple, pattern] of Object.entries(resolver.assets)) {
      const assetName = pattern.replace(/\{tag\}/g, tag);
      const asset = release.assets.find((a) => a.name === assetName);
      if (!asset) {
        info(
          colors.yellow(
            `  no asset named "${assetName}" in ${resolver.repo}@${tag}; skipping triple ${triple}`,
          ),
        );
        continue;
      }
      // GitHub now exposes a `digest: "sha256:<hex>"` field on assets for
      // recent releases — use it when available to avoid streaming hundreds
      // of MB. Fall back to streaming the asset ourselves.
      let sha256: string;
      if (asset.digest && asset.digest.startsWith("sha256:")) {
        sha256 = asset.digest.slice("sha256:".length);
      } else {
        info(`  hashing ${assetName}`);
        sha256 = await sha256OfUrl(asset.browser_download_url);
      }
      platforms[triple as Triple] = {
        url: asset.browser_download_url,
        sha256,
      };
    }
    if (Object.keys(platforms).length === 0) {
      fail(`no platforms resolved for ${kind} (check asset name patterns)`);
    }
    binaries[kind] = { version: tag, platforms };
  }

  const sig = await ed.signAsync(
    new TextEncoder().encode(canonicalize(binaries)),
    privateKey,
  );
  return {
    schemaVersion: 1,
    binaries,
    signature: encodeBase64(sig),
  };
}

// ---------------------------------------------------------------------------
// Tauri client build + updater manifest

const TAURI_DIR = join(REPO_ROOT, "packages/tomat-client/src/tauri");
const TAURI_CONF_PATH = join(TAURI_DIR, "tauri.conf.json");
const TAURI_BUNDLE_OUT = join(TAURI_DIR, "target/release/bundle");
// Older builds used a placeholder pubkey substituted at deploy time.
// We now commit the real (public) key directly to tauri.conf.json, but keep
// this constant so any drifted forks with the old placeholder still work.
const TAURI_PUBKEY_PLACEHOLDER = "PLACEHOLDER_REPLACE_AT_BUILD_TIME";

interface ClientBundle {
  triple: Triple;
  /** Path to the bundle file (e.g. .app.tar.gz / .msi / .AppImage). */
  bundlePath: string;
  /** Path to the .sig file emitted by tauri-plugin-updater. */
  sigPath: string;
  /** Just the filename, used both as the R2 key suffix and the URL leaf. */
  filename: string;
  size: number;
}

interface ClientManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/** Triple → Tauri platforms-map key. tauri-plugin-updater uses
 *  `<os>-<arch>` (not the Rust triple), per its docs. */
function tauriPlatformKey(triple: Triple): string {
  if (triple.endsWith("apple-darwin")) {
    return triple.startsWith("aarch64") ? "darwin-aarch64" : "darwin-x86_64";
  }
  if (triple.endsWith("pc-windows-msvc")) {
    return triple.startsWith("aarch64") ? "windows-aarch64" : "windows-x86_64";
  }
  if (triple.endsWith("unknown-linux-gnu")) {
    return triple.startsWith("aarch64") ? "linux-aarch64" : "linux-x86_64";
  }
  fail(`no tauri platform key for triple ${triple}`);
}

/** Detect the host triple — same logic as the install scripts use. */
function detectHostTriple(): Triple {
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  const arched = arch === "aarch64" ? "aarch64" : "x86_64";
  if (os === "darwin") return `${arched}-apple-darwin` as Triple;
  if (os === "linux") return `${arched}-unknown-linux-gnu` as Triple;
  if (os === "windows") return `${arched}-pc-windows-msvc` as Triple;
  fail(`unsupported host OS: ${os}`);
}

/** Reconcile the committed `plugins.updater.pubkey` in tauri.conf.json with
 *  the key in `.env`. Returns a restorer to call in a finally block so we
 *  never leave a substituted pubkey on disk after a failed build.
 *
 *  Three cases:
 *  - committed key matches `.env` → no-op, silent (the common path).
 *  - committed key is the legacy `PLACEHOLDER_REPLACE_AT_BUILD_TIME` →
 *    substitute, then restore.
 *  - committed key is something else → fail loudly (real drift). */
async function injectTauriPubkey(pubkey: string): Promise<() => Promise<void>> {
  const original = await Deno.readTextFile(TAURI_CONF_PATH);
  const committed = JSON.parse(original)?.plugins?.updater?.pubkey;
  if (committed === pubkey) return async () => {};
  if (committed === TAURI_PUBKEY_PLACEHOLDER) {
    const patched = original.replace(TAURI_PUBKEY_PLACEHOLDER, pubkey);
    await Deno.writeTextFile(TAURI_CONF_PATH, patched);
    ok(`substituted tauri updater pubkey placeholder in tauri.conf.json`);
    return async () => {
      await Deno.writeTextFile(TAURI_CONF_PATH, original);
      info(`restored tauri.conf.json placeholder`);
    };
  }
  fail(
    `tauri.conf.json plugins.updater.pubkey does not match .env's ` +
      `TAURI_UPDATER_PUBLIC_KEY. Either commit the right pubkey or clear ` +
      `the field back to "${TAURI_PUBKEY_PLACEHOLDER}".`,
  );
}

async function buildClient(env: DeployEnv): Promise<void> {
  // tauri-plugin-updater reads these envs at build time to sign artifacts.
  const cmd = new Deno.Command("deno", {
    args: ["task", "build:client"],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      TAURI_SIGNING_PRIVATE_KEY: env.tauriUpdaterPrivateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.tauriUpdaterPassword,
    },
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`deno task build:client exited ${code}`);
}

/** Walk target/release/bundle/{macos,msi,appimage}/ for the host triple's
 *  bundle + .sig pair. Returns a single ClientBundle (host-only by design). */
async function findClientBundle(triple: Triple): Promise<ClientBundle> {
  const candidates: { dir: string; ext: string }[] = [];
  if (triple.endsWith("apple-darwin")) {
    candidates.push({
      dir: join(TAURI_BUNDLE_OUT, "macos"),
      ext: ".app.tar.gz",
    });
  } else if (triple.endsWith("pc-windows-msvc")) {
    candidates.push({ dir: join(TAURI_BUNDLE_OUT, "msi"), ext: ".msi" });
    candidates.push({ dir: join(TAURI_BUNDLE_OUT, "nsis"), ext: ".exe" });
  } else if (triple.endsWith("unknown-linux-gnu")) {
    candidates.push({
      dir: join(TAURI_BUNDLE_OUT, "appimage"),
      ext: ".AppImage",
    });
  }
  for (const c of candidates) {
    if (!(await exists(c.dir))) continue;
    for await (const entry of Deno.readDir(c.dir)) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(c.ext)) continue;
      const sigPath = join(c.dir, `${entry.name}.sig`);
      if (!(await exists(sigPath))) continue;
      const bundlePath = join(c.dir, entry.name);
      const stat = await Deno.stat(bundlePath);
      return {
        triple,
        bundlePath,
        sigPath,
        filename: entry.name,
        size: stat.size,
      };
    }
  }
  fail(
    `no Tauri bundle + .sig found for ${triple} under ${
      rel(TAURI_BUNDLE_OUT)
    } ` +
      `(checked ${
        candidates.map((c) => `${rel(c.dir)}/*${c.ext}`).join(", ")
      })`,
  );
}

async function uploadClientBundle(
  env: DeployEnv,
  version: string,
  bundle: ClientBundle,
): Promise<string> {
  const key = `${version}/${bundle.triple}/${bundle.filename}`;
  info(`uploading ${key}  (${humanBytes(bundle.size)})`);
  await r2Put(env.r2Bucket, key, bundle.bundlePath, "application/octet-stream");
  return `https://${env.releasesDomain}/${key}`;
}

async function composeClientManifest(
  version: string,
  bundles: { bundle: ClientBundle; url: string }[],
): Promise<ClientManifest> {
  const platforms: ClientManifest["platforms"] = {};
  for (const { bundle, url } of bundles) {
    const signature = (await Deno.readTextFile(bundle.sigPath)).trim();
    platforms[tauriPlatformKey(bundle.triple)] = { signature, url };
  }
  return {
    version,
    notes: `Tomat ${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

// ---------------------------------------------------------------------------
// stage files into website public/

async function stagePublic(
  coreManifest: CoreManifest,
  binaryManifest: BinaryManifest,
  clientManifest: ClientManifest | null,
): Promise<void> {
  const installOut = join(PUBLIC_DIR, "install");
  const manifestsOut = join(PUBLIC_DIR, "manifests");
  const schemasOut = join(PUBLIC_DIR, "schemas");

  for (const d of [installOut, manifestsOut, schemasOut]) {
    await ensureDir(d);
  }

  const INSTALL_SCRIPTS = [
    "core.sh",
    "core.ps1",
    "core-uninstall.sh",
    "core-uninstall.ps1",
    "client.sh",
    "client.ps1",
    "client-uninstall.sh",
    "client-uninstall.ps1",
  ];
  for (const name of INSTALL_SCRIPTS) {
    await copyFile(join(INSTALL_DIR, name), join(installOut, name));
  }
  ok(`staged install scripts → ${rel(installOut)}`);

  await Deno.writeTextFile(
    join(manifestsOut, "core.json"),
    JSON.stringify(coreManifest, null, 2),
  );
  ok(`signed core.json → ${rel(manifestsOut)}/core.json`);

  await Deno.writeTextFile(
    join(manifestsOut, "binaries.json"),
    JSON.stringify(binaryManifest, null, 2),
  );
  ok(`signed binaries.json → ${rel(manifestsOut)}/binaries.json`);

  if (clientManifest) {
    await Deno.writeTextFile(
      join(manifestsOut, "client.json"),
      JSON.stringify(clientManifest, null, 2),
    );
    ok(`signed client.json → ${rel(manifestsOut)}/client.json`);
  } else {
    info(colors.yellow(`skipping client.json (no Tauri updater keys)`));
  }

  await copyFile(
    join(SHARED_DIR, "src/tools-json-schema.json"),
    join(schemasOut, "tools-v1.json"),
  );
  ok(`staged tools-v1.json → ${rel(schemasOut)}`);
}

// ---------------------------------------------------------------------------
// astro build

async function astroBuild(): Promise<void> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", "npm:astro@^5", "build"],
    cwd: WEBSITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`astro build exited ${code}`);
}

// ---------------------------------------------------------------------------
// wrangler invocations

async function r2Put(
  bucket: string,
  key: string,
  file: string,
  contentType: string,
): Promise<void> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "npm:wrangler@^4",
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--file",
      file,
      "--content-type",
      contentType,
      "--remote",
    ],
    cwd: WEBSITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`wrangler r2 put ${key} exited ${code}`);
}

async function wranglerDeploy(): Promise<void> {
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
// small helpers

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(src: string, dst: string): Promise<void> {
  await ensureDir(dirname(dst));
  await copy(src, dst, { overwrite: true });
}

function rel(p: string): string {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// main

async function main(): Promise<void> {
  const flags = parseFlags();

  console.log(colors.bold(`\ntomat deploy`));
  console.log(colors.dim(`  repo:    ${REPO_ROOT}`));
  console.log(colors.dim(`  triples: ${flags.triples.join(", ")}`));
  if (flags.dryRun) console.log(colors.yellow(`  dry-run mode`));

  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  step("Updating packages/tomat-core/data/signing-keys.json");
  await writeSigningKeys(encodeBase64(env.signingPublicKey));

  step("Reading CORE_VERSION");
  const version = await readCoreVersion();
  ok(`version ${version}`);

  step(`Building Deno binaries (${flags.triples.length} triples)`);
  const artifacts = await buildAll(flags.triples, flags.skipBuild);
  for (const a of artifacts) {
    ok(
      `${a.triple}/${binaryFilename(a.name, a.triple)}  ${
        humanBytes(a.size)
      }  ${a.sha256.slice(0, 12)}…`,
    );
  }

  step(`Building native helpers (${flags.triples.length} triples)`);
  const helpers = await buildHelpers(flags.triples, flags.skipBuild);
  for (const h of helpers) {
    ok(
      `${h.triple}/${binaryFilename(h.name, h.triple)}  ${
        humanBytes(h.size)
      }  ${h.sha256.slice(0, 12)}…`,
    );
  }

  step("Hashing worker scripts");
  const workers = await hashWorkers();
  for (const w of workers) {
    ok(`workers/${w.name}  ${humanBytes(w.size)}  ${w.sha256.slice(0, 12)}…`);
  }

  step("Composing + signing core.json");
  const coreManifest = await composeCoreManifest(
    version,
    artifacts,
    workers,
    helpers,
    env.releasesDomain,
    env.signingPrivateKey,
  );

  step("Composing + signing binaries.json");
  const binaryManifest = await composeBinaryManifest(env.signingPrivateKey);

  // --- client build (host-only) -------------------------------------------
  // Tauri can't cross-compile across OSes for signing reasons; this part
  // runs only when Tauri updater keys are configured AND only for the host
  // triple. CI runs this script on each platform and merges the resulting
  // client.json platforms entries.
  let clientManifest: ClientManifest | null = null;
  let clientBundlesUploaded: { bundle: ClientBundle; url: string }[] = [];
  if (env.tauriUpdaterPublicKey && env.tauriUpdaterPrivateKey) {
    step("Building Tauri client bundle (host-only)");
    const restoreConf = await injectTauriPubkey(env.tauriUpdaterPublicKey);
    try {
      await buildClient(env);
      const hostTriple = detectHostTriple();
      const bundle = await findClientBundle(hostTriple);
      ok(
        `${hostTriple}/${bundle.filename}  ${humanBytes(bundle.size)}  → ` +
          `${rel(bundle.sigPath)}`,
      );
      if (!flags.dryRun) {
        step(`Uploading client bundle to R2 bucket "${env.r2Bucket}"`);
        const url = await uploadClientBundle(env, version, bundle);
        clientBundlesUploaded = [{ bundle, url }];
      } else {
        // For dry-run we still want client.json to reflect what would land.
        const wouldBeUrl =
          `https://${env.releasesDomain}/${version}/${bundle.triple}/${bundle.filename}`;
        clientBundlesUploaded = [{ bundle, url: wouldBeUrl }];
      }

      step("Composing client.json (Tauri updater manifest)");
      clientManifest = await composeClientManifest(
        version,
        clientBundlesUploaded,
      );
    } finally {
      await restoreConf();
    }
  } else {
    info(
      colors.yellow(
        `\nskipping client build/manifest: Tauri updater keys not set in .env`,
      ),
    );
  }

  step("Staging files into packages/tomat-website/public");
  await stagePublic(coreManifest, binaryManifest, clientManifest);

  step("Building Astro site");
  await astroBuild();

  if (flags.dryRun) {
    step("Dry-run: skipping R2 upload + wrangler deploy");
    console.log(
      colors.yellow(
        `\nBuild artifacts ready under dist/ and packages/tomat-website/dist/`,
      ),
    );
    console.log(
      colors.yellow(`Re-run without --dry-run to publish.\n`),
    );
    return;
  }

  step(`Uploading binaries to R2 bucket "${env.r2Bucket}"`);
  for (const a of artifacts) {
    const filename = binaryFilename(a.name, a.triple);
    const key = `${version}/${a.triple}/${filename}`;
    info(`uploading ${key}  (${humanBytes(a.size)})`);
    await r2Put(env.r2Bucket, key, a.path, "application/octet-stream");
  }
  ok(`uploaded ${artifacts.length} binaries`);

  step(`Uploading helpers to R2 bucket "${env.r2Bucket}"`);
  for (const h of helpers) {
    const filename = binaryFilename(h.name, h.triple);
    const key = `${version}/${h.triple}/${filename}`;
    info(`uploading ${key}  (${humanBytes(h.size)})`);
    await r2Put(env.r2Bucket, key, h.path, "application/octet-stream");
  }
  ok(`uploaded ${helpers.length} helpers`);

  step(`Uploading workers to R2 bucket "${env.r2Bucket}"`);
  for (const w of workers) {
    const key = `${version}/workers/${w.name}`;
    info(`uploading ${key}  (${humanBytes(w.size)})`);
    await r2Put(env.r2Bucket, key, w.path, "application/typescript");
  }
  ok(`uploaded ${workers.length} workers`);

  step("Deploying Worker via wrangler");
  await wranglerDeploy();

  console.log(
    "\n" + colors.green(colors.bold("✓ deploy complete")) + "\n" +
      colors.dim("  ") +
      `https://${env.cdnDomain}/install/core.sh\n` +
      colors.dim("  ") +
      `https://${env.cdnDomain}/manifests/core.json\n` +
      colors.dim("  ") +
      `https://${env.cdnDomain}/manifests/binaries.json\n` +
      colors.dim("  ") +
      `https://${env.releasesDomain}/${version}/<triple>/tomat-core\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
