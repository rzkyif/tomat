#!/usr/bin/env -S deno run -A
// Deploys @tomat/website + compiled core binaries to Cloudflare.
//
// End state of a successful run:
//   - https://au.tomat.ing/                       — landing page
//   - https://au.tomat.ing/manifests/core.json    — signed self-update manifest
//   - https://au.tomat.ing/install/core.{sh,ps1}  — install one-liners
//   - https://au.tomat.ing/schemas/tools-v1.json  — tools.json JSON Schema
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
  CoreManifest,
  Triple,
} from "../../packages/tomat-shared/src/domain/model.ts";

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
const SIGNING_KEYS_PATH = join(CORE_DIR, "src/signing-keys.ts");
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
  "embeddingWorker.ts",
  "toolWorker.ts",
  "ttsWorker.ts",
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

  return {
    signingPrivateKey: decodeBase64(privB64),
    signingPublicKey: decodeBase64(pubB64),
    cdnDomain: get("TOMAT_CDN_DOMAIN") || "au.tomat.ing",
    releasesDomain: get("TOMAT_RELEASES_DOMAIN") || "get.au.tomat.ing",
    r2Bucket: get("TOMAT_R2_BUCKET") || "tomat-releases",
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
// signing-keys.ts regeneration

async function writeSigningKeys(publicKeyB64: string): Promise<void> {
  const content =
    `// Ed25519 public keys for verifying signed manifests from the Tomat CDN.
//
// AUTO-GENERATED by \`deno task website:deploy\` from the keypair in .env.
// Commit changes to this file — public keys are the trust root, not secret.
// If you rotate the keypair in .env, re-run the deploy task and commit the
// updated values here so existing core binaries can verify new manifests.

export const MANIFEST_PUBLIC_KEY_B64 = "${publicKeyB64}";
export const CORE_PUBLIC_KEY_B64 = "${publicKeyB64}";
`;
  await Deno.writeTextFile(SIGNING_KEYS_PATH, content);
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
  // sibling but isn't itself selected by the self-update flow (selfUpdater
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

// ---------------------------------------------------------------------------
// stage files into website public/

async function stagePublic(manifest: CoreManifest): Promise<void> {
  const installOut = join(PUBLIC_DIR, "install");
  const manifestsOut = join(PUBLIC_DIR, "manifests");
  const schemasOut = join(PUBLIC_DIR, "schemas");

  for (const d of [installOut, manifestsOut, schemasOut]) {
    await ensureDir(d);
  }

  await copyFile(
    join(INSTALL_DIR, "core.sh"),
    join(installOut, "core.sh"),
  );
  await copyFile(
    join(INSTALL_DIR, "core.ps1"),
    join(installOut, "core.ps1"),
  );
  ok(`staged install scripts → ${rel(installOut)}`);

  await Deno.writeTextFile(
    join(manifestsOut, "core.json"),
    JSON.stringify(manifest, null, 2),
  );
  ok(`signed core.json → ${rel(manifestsOut)}/core.json`);

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

  step("Updating packages/tomat-core/src/signing-keys.ts");
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
  const manifest = await composeCoreManifest(
    version,
    artifacts,
    workers,
    helpers,
    env.releasesDomain,
    env.signingPrivateKey,
  );

  step("Staging files into packages/tomat-website/public");
  await stagePublic(manifest);

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
