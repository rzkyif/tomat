// Release item: the Tauri client bundle for the host platform, signed with the
// Tauri updater key, uploaded to R2, and merged into client.json. Tauri can't
// cross-compile across OSes for signing reasons, so this is host-only: each
// platform publishes its own bundle and the merge preserves the others at the
// same version. Versioned via packages/tomat-client/src/tauri/tauri.conf.json.

import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path";
import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";
import {
  type ApplyOpts,
  channelManifestDir,
  channelStoragePrefix,
  colors,
  type DeployEnv,
  detectHostTriple,
  DIST_DIR,
  exists,
  fail,
  fetchLiveJson,
  hashPaths,
  humanBytes,
  info,
  ok,
  packagesHashInputs,
  r2Put,
  rel,
  type ReleaseChannel,
  type ReleaseItem,
  REPO_ROOT,
  sha256File,
  signEd25519Bytes,
  step,
} from "./lib.ts";

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
  platforms: Record<string, { signature: string; url: string; sha256: string }>;
}

/** The client's published version is the one baked into the app bundle by Tauri
 *  (tauri.conf.json), which is exactly what Tauri's updater compares against
 *  client.json. Sourcing it from anywhere else risks an update loop. */
async function readClientVersion(): Promise<string> {
  const conf = JSON.parse(await Deno.readTextFile(TAURI_CONF_PATH)) as {
    version?: string;
  };
  if (!conf.version) fail(`no version in ${rel(TAURI_CONF_PATH)}`);
  return conf.version;
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

// The primary installable a plain `deno task build:client` emits for the host
// platform (no updater .tar.gz/.sig, which a keyless build skips). The unified
// build hashes these so a wiped or swapped bundle forces a rebuild. macOS
// returns the .app directory (hashPaths walks it); others the installer file.
export async function clientBuildOutputs(): Promise<string[]> {
  const triple = detectHostTriple();
  const checks: { dir: string; ext: string }[] = [];
  if (triple.endsWith("apple-darwin")) {
    checks.push({ dir: join(TAURI_BUNDLE_OUT, "macos"), ext: ".app" });
  } else if (triple.endsWith("pc-windows-msvc")) {
    checks.push({ dir: join(TAURI_BUNDLE_OUT, "msi"), ext: ".msi" });
    checks.push({ dir: join(TAURI_BUNDLE_OUT, "nsis"), ext: ".exe" });
  } else if (triple.endsWith("unknown-linux-gnu")) {
    checks.push({ dir: join(TAURI_BUNDLE_OUT, "appimage"), ext: ".AppImage" });
  }
  const found: string[] = [];
  for (const c of checks) {
    if (!(await exists(c.dir))) continue;
    for await (const entry of Deno.readDir(c.dir)) {
      if (entry.name.endsWith(c.ext)) found.push(join(c.dir, entry.name));
    }
  }
  return found;
}

function composeClientManifest(
  version: string,
  hostKey: string,
  url: string,
  signature: string,
  sha256: string,
  live: ClientManifest | null,
): ClientManifest {
  // Carry forward platform entries from the prior manifest only if it's the
  // same version. A version bump invalidates platforms not yet re-published.
  const carryover = live?.version === version ? live.platforms : {};
  return {
    version,
    notes: `tomat ${version}`,
    pub_date: new Date().toISOString(),
    platforms: { ...carryover, [hostKey]: { signature, url, sha256 } },
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
// release item

// The desktop client bundles the Tauri shell + the shared UI; its source hash
// is derived from those two packages (src + manifest each).
const CLIENT_PACKAGES = ["client", "shared"];
const CLIENT_HASH_INPUTS = packagesHashInputs(CLIENT_PACKAGES);

export const clientItem: ReleaseItem = {
  id: "client",
  label: "desktop client",
  scope: "channel",
  packages: CLIENT_PACKAGES,
  bumpHint: "packages/tomat-client/src/tauri/tauri.conf.json (version)",

  version: readClientVersion,

  sourceHash(_channel: ReleaseChannel): Promise<string> {
    return hashPaths(
      CLIENT_HASH_INPUTS.map((p) => ({
        path: join(REPO_ROOT, p),
        exclude: (r) => r.endsWith(".test.ts") || r.includes("/target/"),
      })),
    );
  },

  buildOutputs(_channel: ReleaseChannel): Promise<string[]> {
    return clientBuildOutputs();
  },

  // Beyond a source change, the host platform may simply not be published yet
  // at the current version (another machine released a different platform).
  // That makes the item "changed" but needs no version bump.
  async extraChanged(env: DeployEnv, channel: ReleaseChannel): Promise<boolean> {
    const version = await readClientVersion();
    const manifestDir = channelManifestDir(channel);
    const live = await fetchLiveJson<ClientManifest>(env, `${manifestDir}/client.json`);
    const hostKey = tauriPlatformKey(detectHostTriple());
    return !(live && live.version === version && live.platforms[hostKey]);
  },

  async apply(env: DeployEnv, channel: ReleaseChannel, opts: ApplyOpts): Promise<void> {
    const manifestDir = channelManifestDir(channel);
    const storagePrefix = channelStoragePrefix(channel);
    const version = await readClientVersion();

    const hostTriple = detectHostTriple();
    const hostKey = tauriPlatformKey(hostTriple);
    info(`host triple: ${hostTriple} (tauri key: ${hostKey}), version ${version}`);

    const live = await fetchLiveJson<ClientManifest>(env, `${manifestDir}/client.json`);

    // The bundle's download URL is deterministic (it's where we'll upload it),
    // so the signed manifest can be composed before the upload.
    step("Building Tauri client bundle (host-only)");
    const restore = await injectTauriPubkey(env.tauriUpdaterPublicKey);
    try {
      await buildClient(env, channel);
      const bundle = await findClientBundle(hostTriple);
      ok(`${hostTriple}/${bundle.filename}  ${humanBytes(bundle.size)}  → ${rel(bundle.sigPath)}`);

      const bundleKey = `${storagePrefix}${version}/${bundle.triple}/${bundle.filename}`;
      const bundleUrl = `https://${env.storageDomain}/${bundleKey}`;

      step("Composing client.json (Tauri updater manifest)");
      const signature = (await Deno.readTextFile(bundle.sigPath)).trim();
      // sha256 over the exact bytes the installer downloads, so client.sh can
      // verify integrity before install (mirrors core.json). The Tauri minisign
      // signature protects in-app updates; this protects the FIRST install.
      const { sha256 } = await sha256File(bundle.bundlePath);
      const manifest = composeClientManifest(version, hostKey, bundleUrl, signature, sha256, live);
      const clientJsonPath = await writeManifestFile(manifestDir, "client.json", manifest);
      ok(`client.json → ${rel(clientJsonPath)}`);

      // Detached Ed25519 signature over the exact client.json bytes, so client.sh
      // authenticates the manifest (and thus the sha256 it trusts) before
      // installing. client.json is the Tauri updater endpoint, so the signature
      // is a sidecar file rather than an added field (Tauri never fetches it).
      const clientJsonSig = await signEd25519Bytes(
        env.signingPrivateKey,
        await Deno.readFile(clientJsonPath),
      );
      const clientSigPath = join(DIST_DIR, manifestDir, "client.json.sig");
      await Deno.writeTextFile(clientSigPath, clientJsonSig);
      ok(`client.json.sig → ${rel(clientSigPath)}`);

      if (opts.dryRun) {
        info(
          colors.yellow(`dry-run: skipping upload of client bundle + ${manifestDir}/client.json`),
        );
        return;
      }

      step(`Uploading client bundle to R2 bucket "${env.r2Bucket}"`);
      info(`uploading ${bundleKey}  (${humanBytes(bundle.size)})`);
      await r2Put(env, bundleKey, bundle.bundlePath, "application/octet-stream");

      step(`Uploading ${manifestDir}/client.json to R2`);
      await r2Put(
        env,
        `${manifestDir}/client.json`,
        clientJsonPath,
        "application/json",
        MANIFEST_CACHE_CONTROL,
      );
      ok(`https://${env.storageDomain}/${manifestDir}/client.json`);

      step(`Uploading ${manifestDir}/client.json.sig to R2`);
      await r2Put(
        env,
        `${manifestDir}/client.json.sig`,
        clientSigPath,
        "text/plain",
        MANIFEST_CACHE_CONTROL,
      );
      ok(`https://${env.storageDomain}/${manifestDir}/client.json.sig`);
    } finally {
      await restore();
    }
  },
};
