#!/usr/bin/env -S deno run -A
// release:toolkit: packs the built-in toolkit into a gzipped tarball, composes +
// signs toolkit.json (whole-manifest-minus-signature, like core.json), and
// uploads both to R2. Per-version idempotent.
//
// Flags:
//   --channel=stable|beta   (required via the channel-specific deno tasks)
//   --dry-run               build locally; skip R2 upload
//   --force                 skip the version-equality probe
//   --help

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import { walk } from "@std/fs/walk";
import { dirname, join, relative } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar";
import { encodeBase64 } from "@std/encoding/base64";
import type { BuiltinToolkitManifest } from "../../packages/tomat-shared/src/domain/model.ts";
import { BUILTIN_TOOLKIT_ID } from "../../packages/tomat-shared/src/domain/toolkit.ts";
import {
  channelManifestDir,
  channelStoragePrefix,
  colors,
  DIST_DIR,
  fail,
  fetchLiveJson,
  humanBytes,
  info,
  loadOrSeedEnv,
  ok,
  parseChannelFlag,
  r2Put,
  rel,
  type ReleaseChannel,
  REPO_ROOT,
  sha256File,
  signEd25519,
  step,
  writeSigningKeys,
} from "./lib.ts";

const PKG_DIR = join(REPO_ROOT, "packages/tomat-builtin-toolkit");
const MANIFEST_CACHE_CONTROL = "public, max-age=300";
// Dev / VCS / test cruft, plus the lockfile (deno regenerates it on install).
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "tests"]);
const EXCLUDE_FILES = new Set(["deno.lock"]);

interface Flags {
  channel: ReleaseChannel;
  dryRun: boolean;
  force: boolean;
}

function parseFlags(): Flags {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel"],
      boolean: ["dry-run", "force", "help"],
      default: { "dry-run": false, force: false, help: false },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task release:toolkit:<channel> [flags]

Flags:
  --channel=<c>   stable | beta
  --dry-run       build locally; skip R2 upload
  --force         skip the version-equality probe
  --help`);
    Deno.exit(0);
  }
  return {
    channel: parseChannelFlag(args.channel),
    dryRun: args["dry-run"],
    force: args.force,
  };
}

async function readToolkitVersion(): Promise<string> {
  const cfg = JSON.parse(await Deno.readTextFile(join(PKG_DIR, "deno.json"))) as {
    version?: string;
  };
  if (!cfg.version) fail(`no version in ${rel(join(PKG_DIR, "deno.json"))}`);
  return cfg.version;
}

/** Pack the toolkit into a gzipped tarball with entries at the root (no
 *  `package/` prefix), so the core installer extracts it directly. Files are
 *  sorted for a deterministic archive. */
async function buildTarball(outPath: string): Promise<void> {
  const files: { rel: string; abs: string; size: number }[] = [];
  for await (const entry of walk(PKG_DIR, { includeDirs: false, includeFiles: true })) {
    const relPath = relative(PKG_DIR, entry.path);
    const segs = relPath.split("/");
    if (segs.some((s) => EXCLUDE_DIRS.has(s))) continue;
    if (EXCLUDE_FILES.has(relPath)) continue;
    if (relPath.endsWith(".test.ts")) continue; // colocated tests aren't shipped
    files.push({ rel: relPath, abs: entry.path, size: (await Deno.stat(entry.path)).size });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const inputs: TarStreamInput[] = [];
  for (const f of files) {
    inputs.push({
      type: "file",
      path: f.rel,
      size: f.size,
      readable: (await Deno.open(f.abs)).readable,
    });
  }

  await ensureDir(dirname(outPath));
  const out = await Deno.open(outPath, { create: true, write: true, truncate: true });
  await ReadableStream.from(inputs)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(out.writable);
}

export async function main(): Promise<void> {
  const flags = parseFlags();
  const prefix = channelStoragePrefix(flags.channel);
  const manifestDir = channelManifestDir(flags.channel);

  step(`Releasing built-in toolkit for the "${flags.channel}" channel`);
  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  step("Updating packages/tomat-core/data/signing-keys.json");
  await writeSigningKeys(encodeBase64(env.signingPublicKey));

  step("Reading toolkit version");
  const version = await readToolkitVersion();
  ok(`version ${version}`);

  if (!flags.force) {
    step("Probing release state");
    const live = await fetchLiveJson<{ version?: string }>(env, `${manifestDir}/toolkit.json`);
    if (live?.version === version) {
      ok(`${manifestDir}/toolkit.json already at version ${version}; nothing to do`);
      return;
    }
    if (live) info(`live toolkit.json at version ${live.version}; releasing ${version}`);
    else info(`no live toolkit.json yet; first ${flags.channel} release`);
  }

  step("Packing tarball");
  const tgzName = `${BUILTIN_TOOLKIT_ID}-${version}.tgz`;
  const tgzPath = join(DIST_DIR, manifestDir, "toolkit", tgzName);
  await buildTarball(tgzPath);
  const { sha256, size } = await sha256File(tgzPath);
  ok(`${rel(tgzPath)}  ${humanBytes(size)}  ${sha256.slice(0, 12)}…`);

  step("Composing + signing toolkit.json");
  const tarballKey = `${prefix}${version}/toolkit/${tgzName}`;
  const unsigned: Omit<BuiltinToolkitManifest, "signature"> = {
    schemaVersion: 1,
    version,
    id: BUILTIN_TOOLKIT_ID,
    tarballUrl: `https://${env.storageDomain}/${tarballKey}`,
    sha256,
  };
  const manifest: BuiltinToolkitManifest = {
    ...unsigned,
    signature: await signEd25519(env.signingPrivateKey, unsigned),
  };
  const manifestPath = join(DIST_DIR, manifestDir, "toolkit.json");
  await ensureDir(join(DIST_DIR, manifestDir));
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
  ok(`signed toolkit.json → ${rel(manifestPath)}`);

  if (flags.dryRun) {
    step("Dry-run: skipping R2 uploads");
    console.log(
      colors.yellow(
        `\nArtifacts under ${rel(join(DIST_DIR, manifestDir))}. Re-run without --dry-run to publish.`,
      ),
    );
    return;
  }

  step(`Uploading to R2 bucket "${env.r2Bucket}"`);
  info(`uploading ${tarballKey}  (${humanBytes(size)})`);
  await r2Put(env, tarballKey, tgzPath, "application/gzip");
  await r2Put(
    env,
    `${manifestDir}/toolkit.json`,
    manifestPath,
    "application/json",
    MANIFEST_CACHE_CONTROL,
  );
  ok(`uploaded tarball + ${manifestDir}/toolkit.json`);

  console.log(
    "\n" +
      colors.green(colors.bold(`✓ release:toolkit complete (${flags.channel})`)) +
      "\n" +
      colors.dim("  ") +
      `https://${env.storageDomain}/${manifestDir}/toolkit.json\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
