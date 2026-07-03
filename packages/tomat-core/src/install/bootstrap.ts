// One-time secret + content bootstrap for a core install.
//
// Runs before (or as part of) install-service: it ensures the core directory
// tree exists, mints the admin token that authorizes pairing-code minting over
// loopback, optionally seeds the bind-all setting, and plants the built-in
// extension so core installs it OFFLINE on first boot (core re-verifies the
// Ed25519 signature + tarball sha256 before extracting - see extensions/
// seeding.ts). Idempotent: an existing token / settings / planted extension is
// left untouched.

import { join } from "@std/path";
import { BUILTIN_EXTENSION_ID, errMessage } from "@tomat/shared";
import { channel, ensureDirs, paths } from "../paths.ts";
import { builtinExtensionManifestUrl } from "../config.ts";
import { Sha256Stream, toHex } from "../shared/hash.ts";
import { progress } from "./io.ts";
import { run } from "./proc.ts";

export interface BootstrapOptions {
  /** Seed settings.json with server.bindHost=0.0.0.0 so LAN devices can pair
   *  (TOMAT_INSTALL_BIND_ALL=1). */
  bindAll: boolean;
}

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  await ensureDirs();
  await ensureAdminToken();
  if (opts.bindAll) await seedBindAll();
  await plantBuiltinExtension();
}

async function ensureAdminToken(): Promise<void> {
  const file = paths().adminTokenFile;
  if (await fileNonEmpty(file)) {
    progress("admin token already present");
    return;
  }
  const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
  await Deno.writeTextFile(file, token);
  await restrictToOwner(file);
  progress("wrote admin token");
}

async function seedBindAll(): Promise<void> {
  const file = paths().settingsFile;
  if (await fileExists(file)) {
    progress("settings.json already present; leaving bindHost as-is");
    return;
  }
  await Deno.writeTextFile(file, `{"server.bindHost":"0.0.0.0"}\n`);
  progress("seeded settings.json (server.bindHost=0.0.0.0)");
}

// Plant `.tomat-extension-builtin.{tgz,json}` beside the extensions dir. The
// filenames mirror extensions/seeding.ts's planted{Tarball,Manifest}(). Every
// failure is non-fatal: core fetches + verifies + seeds the built-in itself when
// the plant is missing. Skipped on dev (the samples/built-in resolve from the
// codebase there) and when the files are already present (native installer
// payload / re-run).
async function plantBuiltinExtension(): Promise<void> {
  if (channel() === "dev") return;
  const tarballDest = join(paths().extensionsDir, `.${BUILTIN_EXTENSION_ID}.tgz`);
  const manifestDest = join(paths().extensionsDir, `.${BUILTIN_EXTENSION_ID}.json`);
  if ((await fileExists(tarballDest)) && (await fileExists(manifestDest))) {
    progress("built-in extension already planted");
    return;
  }
  try {
    const res = await fetch(builtinExtensionManifestUrl());
    if (!res.ok) {
      progress(`built-in extension manifest unavailable (HTTP ${res.status}); core will seed`);
      return;
    }
    const raw = await res.text();
    const manifest = JSON.parse(raw) as { tarballUrl?: string; sha256?: string };
    if (!manifest.tarballUrl || !manifest.sha256) {
      progress("built-in extension manifest incomplete; core will seed");
      return;
    }
    await Deno.mkdir(paths().stagingDir, { recursive: true });
    const tmp = join(paths().stagingDir, `builtin-extension-${crypto.randomUUID()}.tgz`);
    // sha256 here is only a transport-corruption guard; core re-verifies the
    // manifest signature + tarball hash OFFLINE before it installs on boot.
    const got = await downloadToFile(manifest.tarballUrl, tmp);
    if (got !== manifest.sha256.toLowerCase()) {
      await Deno.remove(tmp).catch(() => {});
      progress("built-in extension checksum mismatch; core will seed");
      return;
    }
    await Deno.rename(tmp, tarballDest);
    // The signed manifest must sit beside the tarball or core can't verify +
    // install offline. Write BOM-free so Deno's JSON.parse accepts it.
    await Deno.writeTextFile(manifestDest, raw);
    progress("planted built-in extension for offline seed");
  } catch (err) {
    progress(`built-in extension plant skipped (core will seed): ${errMessage(err)}`);
  }
}

// --- helpers --------------------------------------------------------------

async function downloadToFile(url: string, outPath: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status} for ${url}`);
  const file = await Deno.open(outPath, { create: true, write: true, truncate: true });
  const sha = new Sha256Stream();
  try {
    for await (const chunk of res.body) {
      await file.write(chunk);
      sha.update(chunk);
    }
  } finally {
    file.close();
  }
  return await sha.hexDigest();
}

// Owner-only permissions on the admin token: chmod 0600 on unix, an
// inheritance-stripped owner-full ACL on Windows (mirrors core.ps1's Set-Acl).
async function restrictToOwner(file: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await run(["icacls", file, "/inheritance:r", "/grant:r", `${username()}:F`], {
      ignoreError: true,
    });
    return;
  }
  await Deno.chmod(file, 0o600);
}

function username(): string {
  return Deno.env.get("USERNAME") ?? Deno.env.get("USER") ?? "";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileNonEmpty(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile && st.size > 0;
  } catch {
    return false;
  }
}
