// Release item: the built-in toolkit, packed into a gzipped tarball with a
// signed toolkit.json manifest (whole-manifest-minus-signature, like
// core.json). Versioned via packages/tomat-builtin-toolkit/deno.json.

import { ensureDir } from "@std/fs/ensure-dir";
import { walk } from "@std/fs/walk";
import { dirname, join, relative } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar";
import type { BuiltinToolkitManifest } from "../../packages/tomat-shared/src/domain/model.ts";
import { BUILTIN_TOOLKIT_ID } from "../../packages/tomat-shared/src/domain/toolkit.ts";
import {
  type ApplyOpts,
  channelManifestDir,
  channelStoragePrefix,
  colors,
  type DeployEnv,
  DIST_DIR,
  hashPaths,
  humanBytes,
  info,
  ok,
  r2Put,
  readVersionField,
  type ReleaseChannel,
  type ReleaseItem,
  rel,
  REPO_ROOT,
  sha256File,
  signEd25519,
  step,
} from "./lib.ts";

const PKG_DIR = join(REPO_ROOT, "packages/tomat-builtin-toolkit");
const MANIFEST_CACHE_CONTROL = "public, max-age=300";
// Dev / VCS / test cruft, plus the lockfile (deno regenerates it on install).
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "tests"]);
const EXCLUDE_FILES = new Set(["deno.lock"]);

/** True when a packed path (relative to PKG_DIR) is excluded from the toolkit
 *  archive. Shared by buildTarball and sourceHash so the two never disagree. */
function isExcluded(relPath: string): boolean {
  const segs = relPath.split("/");
  if (segs.some((s) => EXCLUDE_DIRS.has(s))) return true;
  if (EXCLUDE_FILES.has(relPath)) return true;
  return relPath.endsWith(".test.ts");
}

function readToolkitVersion(): Promise<string> {
  return readVersionField(join(PKG_DIR, "deno.json"));
}

/** Pack the toolkit into a gzipped tarball with entries at the root (no
 *  `package/` prefix), so the core installer extracts it directly. Files are
 *  sorted for a deterministic archive. */
async function buildTarball(outPath: string): Promise<void> {
  const files: { rel: string; abs: string; size: number }[] = [];
  for await (const entry of walk(PKG_DIR, { includeDirs: false, includeFiles: true })) {
    const relPath = relative(PKG_DIR, entry.path);
    if (isExcluded(relPath)) continue;
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

export const toolkitItem: ReleaseItem = {
  id: "toolkit",
  label: "built-in toolkit",
  scope: "channel",
  bumpHint: "packages/tomat-builtin-toolkit/deno.json (version)",

  version: readToolkitVersion,

  sourceHash(_channel: ReleaseChannel): Promise<string> {
    const pkgRel = relative(REPO_ROOT, PKG_DIR) + "/";
    return hashPaths([
      {
        path: PKG_DIR,
        exclude: (r) => isExcluded(r.startsWith(pkgRel) ? r.slice(pkgRel.length) : r),
      },
    ]);
  },

  async apply(env: DeployEnv, channel: ReleaseChannel, opts: ApplyOpts): Promise<void> {
    const prefix = channelStoragePrefix(channel);
    const manifestDir = channelManifestDir(channel);
    const version = await readToolkitVersion();

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

    if (opts.dryRun) {
      info(colors.yellow(`dry-run: skipping upload of ${manifestDir}/toolkit.json`));
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
    ok(`https://${env.storageDomain}/${manifestDir}/toolkit.json`);
  },
};
