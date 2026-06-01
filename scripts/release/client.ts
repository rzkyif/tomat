#!/usr/bin/env -S deno run -A
// release:client builds the Tauri client bundle for the host platform,
// signs it with the Tauri updater key, uploads the bundle to R2, and merges
// the host-platform entry into manifests/client.json on R2.
//
// Tauri can't cross-compile across OSes for signing reasons, so this is
// inherently host-only. CI runs `release:client` on each platform; the
// merge step preserves entries from prior runs at the same version.
//
// Flags:
//   --dry-run                            do everything locally; skip R2 uploads
//   --force                              skip the version+platform probe
//   --help

import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { join } from "jsr:@std/path@^1";
import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";
import {
  channelManifestDir,
  channelStoragePrefix,
  colors,
  type DeployEnv,
  detectHostTriple,
  DIST_DIR,
  exists,
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
  step,
  writeSigningKeys,
} from "./lib.ts";
import { encodeBase64 } from "jsr:@std/encoding@^1/base64";

// ---------------------------------------------------------------------------
// paths

const TAURI_DIR = join(REPO_ROOT, "packages/tomat-client/src/tauri");
const TAURI_CONF_PATH = join(TAURI_DIR, "tauri.conf.json");
const TAURI_BUNDLE_OUT = join(REPO_ROOT, "target/release/bundle");
// Legacy placeholder, kept for forks that still ship it.
const TAURI_PUBKEY_PLACEHOLDER = "PLACEHOLDER_REPLACE_AT_BUILD_TIME";

const MANIFEST_CACHE_CONTROL = "public, max-age=300";

// ---------------------------------------------------------------------------
// types

interface ClientBundle {
  triple: Triple;
  bundlePath: string;
  sigPath: string;
  filename: string;
  size: number;
}

interface ClientManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

interface Flags {
  dryRun: boolean;
  force: boolean;
  channel: ReleaseChannel;
}

// ---------------------------------------------------------------------------
// flags

function parseFlags(): Flags {
  // Strip the bare `--` token that `deno task <name> -- ...` passes through.
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel"],
      boolean: ["dry-run", "force", "help"],
      default: { "dry-run": false, force: false, help: false },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task release:client [flags]

Flags:
  --channel=<c>  stable (default) | beta. Beta builds a distinctly-named app
                 (tomat-beta) and publishes to manifests/beta/client.json.
  --dry-run      skip R2 upload + manifest publish
  --force        skip the version+platform idempotency probe
  --help`);
    Deno.exit(0);
  }
  return {
    dryRun: args["dry-run"],
    force: args.force,
    channel: parseChannelFlag(args.channel),
  };
}

// ---------------------------------------------------------------------------
// tauri platform key (release/install scripts use the Rust triple; tauri's
// updater consumes <os>-<arch> instead)

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

// ---------------------------------------------------------------------------
// tauri.conf.json pubkey reconciliation

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

// ---------------------------------------------------------------------------
// build client + locate bundle

async function buildClient(env: DeployEnv, channel: ReleaseChannel): Promise<void> {
  // Drive build-client.ts directly with the channel so it bakes TOMAT_CHANNEL
  // + applies the per-channel app-identity config override.
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", "scripts/build-client.ts", `--channel=${channel}`],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Deno.env.toObject(),
      TAURI_SIGNING_PRIVATE_KEY: env.tauriUpdaterPrivateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.tauriUpdaterPassword,
    },
  });
  const { code } = await cmd.output();
  if (code !== 0) fail(`build-client.ts (${channel}) exited ${code}`);
}

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
    `no Tauri bundle + .sig found for ${triple} under ${rel(TAURI_BUNDLE_OUT)} ` +
      `(checked ${candidates.map((c) => `${rel(c.dir)}/*${c.ext}`).join(", ")})`,
  );
}

async function uploadClientBundle(
  env: DeployEnv,
  version: string,
  bundle: ClientBundle,
  storagePrefix: string,
): Promise<string> {
  const key = `${storagePrefix}${version}/${bundle.triple}/${bundle.filename}`;
  info(`uploading ${key}  (${humanBytes(bundle.size)})`);
  await r2Put(env, key, bundle.bundlePath, "application/octet-stream");
  return `https://${env.storageDomain}/${key}`;
}

function composeClientManifest(
  version: string,
  hostKey: string,
  url: string,
  signature: string,
  live: ClientManifest | null,
): ClientManifest {
  // Carry forward platform entries from the prior manifest only if it's the
  // same version. A version bump invalidates platforms that haven't been
  // re-published yet.
  const carryover = live?.version === version ? live.platforms : {};
  return {
    version,
    notes: `Tomat ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      ...carryover,
      [hostKey]: { signature, url },
    },
  };
}

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
  const manifestDir = channelManifestDir(flags.channel);
  const storagePrefix = channelStoragePrefix(flags.channel);

  step(`Releasing client for the "${flags.channel}" channel`);
  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  if (!env.tauriUpdaterPublicKey || !env.tauriUpdaterPrivateKey) {
    info(
      colors.yellow(
        `Tauri updater keys not set in .env. Skipping release:client. ` +
          `Generate with \`cargo tauri signer generate -w .env\` to enable.`,
      ),
    );
    return;
  }

  step("Updating packages/tomat-core/data/signing-keys.json");
  await writeSigningKeys(encodeBase64(env.signingPublicKey));

  step("Reading CORE_VERSION");
  const version = await readCoreVersion();
  ok(`version ${version}`);

  const hostTriple = detectHostTriple();
  const hostKey = tauriPlatformKey(hostTriple);
  info(`host triple: ${hostTriple} (tauri key: ${hostKey})`);

  const live = await fetchLiveJson<ClientManifest>(env, `${manifestDir}/client.json`);

  if (!flags.force) {
    if (live?.version === version && live.platforms[hostKey]) {
      ok(`client.json already at version ${version} for ${hostKey}. Nothing to do`);
      return;
    }
    if (live) {
      info(
        `live client.json at version ${live.version}; ${
          live.platforms[hostKey] ? "re-publishing" : "adding"
        } ${hostKey} for ${version}`,
      );
    } else {
      info(`no live client.json yet; first client release`);
    }
  }

  step("Building Tauri client bundle (host-only)");
  const restore = await injectTauriPubkey(env.tauriUpdaterPublicKey);
  try {
    await buildClient(env, flags.channel);
    const bundle = await findClientBundle(hostTriple);
    ok(`${hostTriple}/${bundle.filename}  ${humanBytes(bundle.size)}  → ${rel(bundle.sigPath)}`);

    let bundleUrl: string;
    if (flags.dryRun) {
      bundleUrl = `https://${env.storageDomain}/${storagePrefix}${version}/${bundle.triple}/${bundle.filename}`;
    } else {
      step(`Uploading client bundle to R2 bucket "${env.r2Bucket}"`);
      bundleUrl = await uploadClientBundle(env, version, bundle, storagePrefix);
    }

    step("Composing client.json (Tauri updater manifest)");
    const signature = (await Deno.readTextFile(bundle.sigPath)).trim();
    const manifest = composeClientManifest(version, hostKey, bundleUrl, signature, live);
    const clientJsonPath = await writeManifestFile(manifestDir, "client.json", manifest);
    ok(`client.json → ${rel(clientJsonPath)}`);

    if (flags.dryRun) {
      step("Dry-run: skipping manifest upload");
      console.log(
        colors.yellow(
          `\nManifest under ${rel(clientJsonPath)}. Re-run without --dry-run to publish.`,
        ),
      );
      return;
    }

    step(`Uploading ${manifestDir}/client.json to R2`);
    await r2Put(
      env,
      `${manifestDir}/client.json`,
      clientJsonPath,
      "application/json",
      MANIFEST_CACHE_CONTROL,
    );
    ok(`uploaded ${manifestDir}/client.json`);
  } finally {
    await restore();
  }

  console.log(
    "\n" +
      colors.green(colors.bold(`✓ release:client complete (${flags.channel})`)) +
      "\n" +
      colors.dim("  ") +
      `https://${env.storageDomain}/${manifestDir}/client.json\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
