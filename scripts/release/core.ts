#!/usr/bin/env -S deno run -A
// release:core: builds tomat-core, tomat-core-updater, tomat-core-keychain
// for each requested triple, hashes the worker .ts files, composes + signs
// core.json and binaries.json, and uploads everything to R2.
//
// Flags:
//   --triples=all                        cross-compile for every supported triple
//   --triples=aarch64-apple-darwin,...   comma-separated subset
//   --skip-build                         reuse dist/<triple>/ from a prior run
//   --dry-run                            do everything locally; skip R2 uploads
//   --force                              skip the version-equality probe
//   --help

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path";
import type {
  BinaryKind,
  BinaryManifest,
  BinaryManifestEntry,
  BinaryManifestPinnedEntry,
  CoreManifest,
  Triple,
} from "../../packages/tomat-shared/src/domain/model.ts";
import { BINARY_KINDS, UPSTREAM_BINARIES } from "../../packages/tomat-shared/src/domain/model.ts";
import {
  channelBinSuffix,
  channelManifestDir,
  channelStoragePrefix,
  colors,
  CORE_DIR,
  DIST_DIR,
  fail,
  fetchLiveJson,
  humanBytes,
  info,
  loadOrSeedEnv,
  ok,
  parseChannelFlag,
  r2Put,
  readCoreVersion,
  rel,
  type ReleaseChannel,
  REPO_ROOT,
  sha256File,
  signEd25519,
  step,
  writeSigningKeys,
} from "./lib.ts";
import { encodeBase64 } from "@std/encoding/base64";

// ---------------------------------------------------------------------------
// constants

const ALL_TRIPLES: Triple[] = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
];

// Worker .ts files shipped alongside the binary (platform-independent).
// These are NOT bundled into the core binary. At runtime, the core spawns
// them as Deno subprocesses from ~/.tomat/core/workers/.
const WORKER_FILES = ["embedding-worker.ts", "tool-worker.ts", "tts-worker.ts"] as const;

const HELPER_CRATES: Array<{
  name: "tomat-core-keychain" | "tomat-core-updater" | "tomat-core-hwinfo" | "tomat-core-ptyhost";
  crateDir: string;
}> = [
  { name: "tomat-core-keychain", crateDir: "packages/tomat-core-keychain" },
  { name: "tomat-core-updater", crateDir: "packages/tomat-core-updater" },
  { name: "tomat-core-hwinfo", crateDir: "packages/tomat-core-hwinfo" },
  { name: "tomat-core-ptyhost", crateDir: "packages/tomat-core-ptyhost" },
];

const MANIFEST_CACHE_CONTROL = "public, max-age=300";

// ---------------------------------------------------------------------------
// types

interface BuildArtifact {
  triple: Triple;
  // Base name, channel-independent. Only tomat-core is deno-compiled now (the
  // updater is a Rust helper crate built by buildHelpers). The on-disk +
  // uploaded filename (with channel suffix + .exe) is `filename`.
  name: "tomat-core";
  filename: string;
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
  // Channel-suffixed manifest entry name (no .exe), e.g. tomat-core-keychain
  // or tomat-core-keychain-beta. `filename` adds .exe on Windows.
  entryName: string;
  filename: string;
  path: string;
  sha256: string;
  size: number;
}

interface Flags {
  triples: Triple[];
  skipBuild: boolean;
  dryRun: boolean;
  force: boolean;
  channel: ReleaseChannel;
}

// ---------------------------------------------------------------------------
// flags

function parseFlags(): Flags {
  // Strip the bare `--` token that `deno task <name> -- ...` passes through
  // literally. @std/cli's parseArgs otherwise treats it as end-of-options
  // and silently drops the trailing flags.
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["triples", "channel"],
      boolean: ["skip-build", "dry-run", "force", "help"],
      default: {
        "skip-build": false,
        "dry-run": false,
        force: false,
        help: false,
      },
    },
  );
  if (args.help) {
    printHelp();
    Deno.exit(0);
  }
  const channel = parseChannelFlag(args.channel);
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
    force: args.force,
    channel,
  };
}

function printHelp(): void {
  console.log(`Usage: deno task release:core:<channel> [flags]

Flags:
  --triples=<list>   comma-separated triples to build. Special values:
                       "host" (default): current machine only
                       "all"            : every supported triple
                                          (${ALL_TRIPLES.join(", ")})
                     Cross-compiling pulls native modules from the host's
                     node_modules into binaries for other platforms, which
                     Deno warns about and which will misbehave at runtime.
                     Build each platform on its own machine for releases.
  --channel=<c>      stable (default) | beta. Beta suffixes our binary names
                     (tomat-core-beta), nests manifests + artifacts under a
                     /beta path segment, and publishes binaries.json with
                     upstream RESOLVER entries (latest-at-runtime) instead of
                     release-time-pinned URLs.
  --skip-build       reuse binaries in dist/ from a prior run
  --dry-run          skip R2 upload
  --force            skip the version-equality idempotency probe
  --help`);
}

// ---------------------------------------------------------------------------
// build

/** Compiling from the live workspace bundles the whole shared
 *  node_modules / npm cache into the output (~2 GB). We sidestep that by
 *  creating a temp directory with symlinks to just `tomat-core` and
 *  `tomat-shared`, plus a minimal root `deno.json` that has no
 *  `nodeModulesDir` and no workspace siblings. Final binary size drops from
 *  ~2.2 GB to ~94 MB. */
async function setupCompileWorkspace(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "tomat-compile-" });
  await Deno.mkdir(join(dir, "packages"));
  await Deno.symlink(join(REPO_ROOT, "packages/tomat-shared"), join(dir, "packages/tomat-shared"));
  await Deno.symlink(join(REPO_ROOT, "packages/tomat-core"), join(dir, "packages/tomat-core"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(
      {
        workspace: ["./packages/tomat-shared", "./packages/tomat-core"],
        unstable: ["raw-imports"],
      },
      null,
      2,
    ),
  );
  // Seed the committed lockfile so the signed binary is built from the exact
  // locked dependency graph rather than a fresh (drift-prone) resolution. We
  // can't pass `--frozen` here because this is a SUBSET workspace (core+shared
  // only), so deno would want to drop the client/website lock entries; instead
  // the lock pins resolution (the temp lock it rewrites is discarded with the
  // dir), and CI's `deno install --frozen` gate keeps the committed lock honest.
  await Deno.copyFile(join(REPO_ROOT, "deno.lock"), join(dir, "deno.lock"));
  return dir;
}

async function compileFor(
  triple: Triple,
  name: string,
  entryRelative: string,
  compileWorkspace: string,
): Promise<string> {
  const isWin = triple.includes("windows");
  const exe = isWin ? ".exe" : "";
  const outDir = join(DIST_DIR, triple);
  await ensureDir(outDir);
  const outPath = join(outDir, `${name}${exe}`);
  const cmd = new Deno.Command("deno", {
    args: ["compile", "--allow-all", "--target", triple, "--output", outPath, entryRelative],
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
  suffix: string,
): Promise<BuildArtifact[]> {
  let compileWorkspace: string | null = null;
  try {
    const artifacts: BuildArtifact[] = [];
    for (const triple of triples) {
      const isWin = triple.includes("windows");
      const exe = isWin ? ".exe" : "";
      for (const [name, entryRelative] of [
        ["tomat-core", "packages/tomat-core/src/main.ts"],
      ] as const) {
        // Channel-suffixed filename so beta's tomat-core-beta coexists with
        // stable's tomat-core both on disk and at the download URL.
        const filename = `${name}${suffix}${exe}`;
        const outPath = join(DIST_DIR, triple, filename);
        if (skipBuild && (await fileExists(outPath))) {
          info(`reusing ${rel(outPath)}`);
        } else {
          if (!compileWorkspace) {
            compileWorkspace = await setupCompileWorkspace();
            info(`compile workspace at ${compileWorkspace}`);
          }
          info(`compiling ${name}${suffix} for ${triple}`);
          await compileFor(triple, `${name}${suffix}`, entryRelative, compileWorkspace);
        }
        const { sha256, size } = await sha256File(outPath);
        artifacts.push({ triple, name, filename, path: outPath, sha256, size });
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
  suffix: string,
): Promise<HelperArtifact[]> {
  const out: HelperArtifact[] = [];
  for (const triple of triples) {
    const isWin = triple.includes("windows");
    const exe = isWin ? ".exe" : "";
    for (const { name, crateDir } of HELPER_CRATES) {
      // Cargo always builds the bare crate name; we copy it out under the
      // channel-suffixed name so beta's tomat-core-keychain-beta coexists.
      const entryName = `${name}${suffix}`;
      const filename = `${entryName}${exe}`;
      const outDir = join(DIST_DIR, triple);
      await ensureDir(outDir);
      const outPath = join(outDir, filename);
      if (skipBuild && (await fileExists(outPath))) {
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
        const builtPath = join(REPO_ROOT, "target", triple, "release", `${name}${exe}`);
        await Deno.copyFile(builtPath, outPath);
      }
      const { sha256, size } = await sha256File(outPath);
      out.push({ triple, entryName, filename, path: outPath, sha256, size });
    }
  }
  return out;
}

async function hashWorkers(): Promise<WorkerArtifact[]> {
  const workersDir = join(CORE_DIR, "src/workers");
  const out: WorkerArtifact[] = [];
  for (const name of WORKER_FILES) {
    const path = join(workersDir, name);
    const { sha256, size } = await sha256File(path);
    out.push({ name, path, sha256, size });
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// manifest assembly

async function composeCoreManifest(
  version: string,
  artifacts: BuildArtifact[],
  workers: WorkerArtifact[],
  helpers: HelperArtifact[],
  storageDomain: string,
  storagePrefix: string,
  privateKey: Uint8Array,
): Promise<CoreManifest> {
  const binaries = artifacts
    .filter((a) => a.name === "tomat-core")
    .map((a) => ({
      triple: a.triple,
      url: `https://${storageDomain}/${storagePrefix}${version}/${a.triple}/${a.filename}`,
      sha256: a.sha256,
    }));

  const workerEntries = workers.map((w) => ({
    name: w.name,
    url: `https://${storageDomain}/${storagePrefix}${version}/workers/${w.name}`,
    sha256: w.sha256,
  }));

  // helpers[] carries the per-triple sidecar binaries that ship next to core
  // and are installed (and swapped on self-update) by the same code path:
  // tomat-core-keychain AND tomat-core-updater. Both are Rust helper crates
  // built by buildHelpers (cargo), so they flow through `helpers` identically.
  // Manifest helper names carry no .exe. Installers/self-updater append
  // platformExe() at runtime; h.entryName is suffixed without .exe, while
  // h.filename adds .exe on Windows for the download URL.
  const helperEntries = helpers.map((h) => ({
    name: h.entryName,
    triple: h.triple,
    url: `https://${storageDomain}/${storagePrefix}${version}/${h.triple}/${h.filename}`,
    sha256: h.sha256,
  }));

  // Sign the WHOLE manifest minus the `signature` field. The runtime verifier
  // (packages/tomat-core/src/update/self-updater.ts) reconstructs the same
  // payload by stripping `signature`, so signer and verifier stay in lockstep
  // and every executed field (binaries, workers, helpers) is authenticated.
  // Do NOT shrink this back to {version,binaries}: that would leave workers[] /
  // helpers[] unsigned and a tampered manifest could inject attacker code.
  const manifest: Omit<CoreManifest, "signature"> = {
    schemaVersion: 1,
    version,
    binaries,
    workers: workerEntries,
    helpers: helperEntries,
  };
  const signature = await signEd25519(privateKey, manifest);
  return { ...manifest, signature };
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

async function fetchRelease(repo: string, pinnedTag?: string): Promise<GitHubRelease> {
  const url = pinnedTag
    ? `https://api.github.com/repos/${repo}/releases/tags/${pinnedTag}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "tomat-release",
  };
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  if (ghToken) headers.authorization = `Bearer ${ghToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    fail(`GitHub API ${res.status} for ${url}: ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as GitHubRelease;
}

async function sha256OfUrl(url: string): Promise<string> {
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
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

async function composeBinaryManifest(
  privateKey: Uint8Array,
  channel: ReleaseChannel,
): Promise<BinaryManifest> {
  const binaries = {} as Record<BinaryKind, BinaryManifestEntry>;
  for (const kind of BINARY_KINDS) {
    const resolver = UPSTREAM_BINARIES[kind];

    // Beta: ship the resolver itself (repo + asset patterns + optional
    // pinned tag) so the core resolves it at runtime. No GitHub call here:
    // the signed manifest commits to the repo/patterns (and the pin, when
    // one is declared, e.g. deno).
    if (channel === "beta") {
      info(`beta resolver entry for ${kind} → ${resolver.repo}`);
      binaries[kind] = {
        resolver: {
          repo: resolver.repo,
          assets: resolver.assets as Record<Triple, string>,
          ...(resolver.pinnedTag ? { pinnedTag: resolver.pinnedTag } : {}),
        },
      };
      continue;
    }

    // Stable: pin URL + sha256 at release time, from the declared pinned tag
    // when one exists (deno) or the current latest otherwise.
    info(`resolving ${resolver.pinnedTag ?? "latest"} ${kind} from ${resolver.repo}`);
    const release = await fetchRelease(resolver.repo, resolver.pinnedTag);
    const tag = release.tag_name;
    info(`  tag: ${tag}`);

    const platforms = {} as BinaryManifestPinnedEntry["platforms"];
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

  const signature = await signEd25519(privateKey, binaries);
  return { schemaVersion: 1, binaries, signature };
}

// ---------------------------------------------------------------------------
// dist/manifests/ output

async function writeManifestFile(
  manifestDir: string,
  name: string,
  body: unknown,
): Promise<string> {
  const dir = join(DIST_DIR, manifestDir);
  await ensureDir(dir);
  const path = join(dir, name);
  await Deno.writeTextFile(path, JSON.stringify(body, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// main

export async function main(): Promise<void> {
  const flags = parseFlags();
  const suffix = channelBinSuffix(flags.channel);
  const prefix = channelStoragePrefix(flags.channel);
  const manifestDir = channelManifestDir(flags.channel);

  step(`Releasing core for the "${flags.channel}" channel`);
  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  step("Updating packages/tomat-core/data/signing-keys.json");
  await writeSigningKeys(encodeBase64(env.signingPublicKey));

  step("Reading CORE_VERSION");
  const version = await readCoreVersion();
  ok(`version ${version}`);

  if (!flags.force) {
    step("Probing release state");
    const live = await fetchLiveJson<{ version?: string }>(env, `${manifestDir}/core.json`);
    if (live?.version === version) {
      ok(`${manifestDir}/core.json already at version ${version}; nothing to do`);
      return;
    }
    if (live) {
      info(`live core.json at version ${live.version}; releasing ${version}`);
    } else {
      info(`no live core.json yet; first ${flags.channel} release`);
    }
  }

  step(`Building Deno binaries (${flags.triples.length} triples)`);
  const artifacts = await buildAll(flags.triples, flags.skipBuild, suffix);
  for (const a of artifacts) {
    ok(`${a.triple}/${a.filename}  ${humanBytes(a.size)}  ${a.sha256.slice(0, 12)}…`);
  }

  step(`Building native helpers (${flags.triples.length} triples)`);
  const helpers = await buildHelpers(flags.triples, flags.skipBuild, suffix);
  for (const h of helpers) {
    ok(`${h.triple}/${h.filename}  ${humanBytes(h.size)}  ${h.sha256.slice(0, 12)}…`);
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
    env.storageDomain,
    prefix,
    env.signingPrivateKey,
  );
  const coreJsonPath = await writeManifestFile(manifestDir, "core.json", coreManifest);
  ok(`signed core.json → ${rel(coreJsonPath)}`);

  step("Composing + signing binaries.json");
  const binaryManifest = await composeBinaryManifest(env.signingPrivateKey, flags.channel);
  const binJsonPath = await writeManifestFile(manifestDir, "binaries.json", binaryManifest);
  ok(`signed binaries.json → ${rel(binJsonPath)}`);

  if (flags.dryRun) {
    step("Dry-run: skipping R2 uploads");
    console.log(
      colors.yellow(
        `\nManifests under ${rel(
          join(DIST_DIR, manifestDir),
        )}. Re-run without --dry-run to publish.`,
      ),
    );
    return;
  }

  step(`Uploading binaries to R2 bucket "${env.r2Bucket}"`);
  for (const a of artifacts) {
    const key = `${prefix}${version}/${a.triple}/${a.filename}`;
    info(`uploading ${key}  (${humanBytes(a.size)})`);
    await r2Put(env, key, a.path, "application/octet-stream");
  }
  ok(`uploaded ${artifacts.length} binaries`);

  step(`Uploading helpers to R2 bucket "${env.r2Bucket}"`);
  for (const h of helpers) {
    const key = `${prefix}${version}/${h.triple}/${h.filename}`;
    info(`uploading ${key}  (${humanBytes(h.size)})`);
    await r2Put(env, key, h.path, "application/octet-stream");
  }
  ok(`uploaded ${helpers.length} helpers`);

  step(`Uploading workers to R2 bucket "${env.r2Bucket}"`);
  for (const w of workers) {
    const key = `${prefix}${version}/workers/${w.name}`;
    info(`uploading ${key}  (${humanBytes(w.size)})`);
    await r2Put(env, key, w.path, "application/typescript");
  }
  ok(`uploaded ${workers.length} workers`);

  step(`Uploading manifests to R2 bucket "${env.r2Bucket}"`);
  await r2Put(
    env,
    `${manifestDir}/core.json`,
    coreJsonPath,
    "application/json",
    MANIFEST_CACHE_CONTROL,
  );
  ok(`uploaded ${manifestDir}/core.json`);
  await r2Put(
    env,
    `${manifestDir}/binaries.json`,
    binJsonPath,
    "application/json",
    MANIFEST_CACHE_CONTROL,
  );
  ok(`uploaded ${manifestDir}/binaries.json`);

  console.log(
    "\n" +
      colors.green(colors.bold(`✓ release:core complete (${flags.channel})`)) +
      "\n" +
      colors.dim("  ") +
      `https://${env.storageDomain}/${manifestDir}/core.json\n` +
      colors.dim("  ") +
      `https://${env.storageDomain}/${manifestDir}/binaries.json\n` +
      colors.dim("  ") +
      `https://${env.storageDomain}/${prefix}${version}/<triple>/tomat-core${suffix}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
