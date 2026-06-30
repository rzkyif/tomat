// Windows build environment: a UTM VM driven headless over SSH.
//
// Builds core + helpers + speech (buildCore) and the Tauri Windows installer -
// MSI/NSIS + the updater `.sig` (buildClient) - in the guest, started on demand
// via utmctl and stopped afterwards. windows-provision.ps1 sets up the guest:
// OpenSSH, the arm64-native deno, MSVC + both Rust windows targets, LLVM/clang
// (sherpa's deps C-compile), and the win-arm64 sherpa lib. Tauri auto-downloads
// WiX/NSIS on the first client build.
//
// One Windows-on-ARM guest builds BOTH windows triples:
//   - aarch64-pc-windows-msvc: native. vcvars `arm64`; `deno compile` (no
//     --target, handled in core.ts); speech links the staged win-arm64 lib via
//     SHERPA_ONNX_LIB_DIR_ARM64.
//   - x86_64-pc-windows-msvc: cross. vcvars `arm64_amd64`; deno compile --target
//     x64; speech uses the win-x64 lib the crate downloads (SHERPA unset).
// Each build command must source vcvars (see buildCore); a non-interactive SSH
// shell has no MSVC environment otherwise.
//
// ============================ FILL THIS IN ============================
const CONFIG = {
  // `utmctl list` -> the VM name (or its UUID).
  vmName: "Windows",
  // Path to utmctl (bundled inside UTM.app). Adjust if UTM is elsewhere.
  utmctl: "/Applications/UTM.app/Contents/MacOS/utmctl",
  // SSH reachability of the guest once booted. NOTE: the host is a DHCP-assigned
  // LAN address (bridged), so it can change across reboots; pin a DHCP
  // reservation or use the guest hostname for stability. user is the Windows
  // account name and is still required (see FILL THIS IN below).
  ssh: {
    host: Deno.env.get("TOMAT_WIN_SSH_HOST") ?? "192.168.3.158",
    user: "VirtualMachine",
    port: 22,
    identityFile: "",
  },
  // Where the repo is available inside the guest (a UTM shared folder is ideal;
  // otherwise rsync/scp the tree here first) and where builds write.
  guestRepo: "C:\\work",
  // Path to vcvarsall.bat (VS Build Tools). Sourced per build to load MSVC.
  vcvarsall:
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat",
  // Both windows triples, built from this one ARM host (see header).
  triples: ["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"] as Triple[],
  // Seconds to wait for the guest's SSH to come up after utmctl start.
  bootTimeoutSec: 180,
};
// =====================================================================

import { join } from "@std/path";
import { ensureDir } from "@std/fs/ensure-dir";
import type { Triple } from "../../../packages/tomat-shared/src/domain/model.ts";
import {
  type ArtifactBundle,
  type ClientDescriptor,
  readBundle,
  readClientDescriptor,
} from "../artifacts.ts";
import { DIST_DIR, ok, step } from "../lib.ts";
import type { BuildEnvironment, ClientBuildRequest, CoreBuildRequest, EnvState } from "./mod.ts";
import { packSourceTarball } from "./source.ts";

function sshBase(): string[] {
  const a = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    `${CONFIG.ssh.port}`,
  ];
  if (CONFIG.ssh.identityFile) a.push("-i", CONFIG.ssh.identityFile);
  return a;
}

async function ssh(remoteCmd: string): Promise<number> {
  const out = await new Deno.Command("ssh", {
    args: [...sshBase(), `${CONFIG.ssh.user}@${CONFIG.ssh.host}`, remoteCmd],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return out.code;
}

async function sshOk(): Promise<boolean> {
  try {
    const out = await new Deno.Command("ssh", {
      args: [...sshBase(), `${CONFIG.ssh.user}@${CONFIG.ssh.host}`, "exit"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

/** Pull a guest path back to a host path via scp -r. */
async function scpFromGuest(guestPath: string, hostPath: string): Promise<number> {
  const port = ["-P", `${CONFIG.ssh.port}`];
  const id = CONFIG.ssh.identityFile ? ["-i", CONFIG.ssh.identityFile] : [];
  const out = await new Deno.Command("scp", {
    args: ["-r", ...port, ...id, `${CONFIG.ssh.user}@${CONFIG.ssh.host}:${guestPath}`, hostPath],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return out.code;
}

/** Push a host file to a guest path via scp. */
async function scpToGuest(hostPath: string, guestPath: string): Promise<number> {
  const port = ["-P", `${CONFIG.ssh.port}`];
  const id = CONFIG.ssh.identityFile ? ["-i", CONFIG.ssh.identityFile] : [];
  const out = await new Deno.Command("scp", {
    args: [...port, ...id, hostPath, `${CONFIG.ssh.user}@${CONFIG.ssh.host}:${guestPath}`],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return out.code;
}

/** Ship the repo source into the guest (scp a tarball, extract). UTM shared
 *  folders over WebDAV are slow/awkward to build from, so we transfer per run. */
async function syncSource(): Promise<void> {
  step(`syncing source to ${CONFIG.vmName}`);
  const repoFwd = CONFIG.guestRepo.replace(/\\/g, "/");
  const tgz = await Deno.makeTempFile({ prefix: "tomat-src-", suffix: ".tgz" });
  try {
    await packSourceTarball(tgz);
    if ((await ssh(`if not exist ${CONFIG.guestRepo} mkdir ${CONFIG.guestRepo}`)) !== 0) {
      throw new Error(`could not create ${CONFIG.guestRepo} in the guest`);
    }
    if ((await scpToGuest(tgz, `${repoFwd}/tomat-src.tgz`)) !== 0)
      throw new Error(`scp source to guest failed`);
    if ((await ssh(`cd /d ${CONFIG.guestRepo} & tar -xf tomat-src.tgz`)) !== 0) {
      throw new Error(`extracting source in the guest failed`);
    }
    // Sweep any stale macOS AppleDouble (`._*`) files a prior sync left behind:
    // tar -xf extracts over the tree but never deletes files absent from the new
    // (now AppleDouble-free) archive, and Tauri chokes on `capabilities/._*.json`.
    // Best-effort; never fail the sync over it.
    await ssh(
      `powershell -NoProfile -Command "Get-ChildItem -LiteralPath '${CONFIG.guestRepo}' ` +
        `-Recurse -Force -Filter '._*' -ErrorAction SilentlyContinue | ` +
        `Remove-Item -Force -ErrorAction SilentlyContinue"`,
    );
  } finally {
    await Deno.remove(tgz).catch(() => {});
  }
}

function utmctl(args: string[]): Deno.Command {
  return new Deno.Command(CONFIG.utmctl, {
    args,
    stdout: "piped",
    stderr: "inherit",
  });
}

export const windowsUtmDriver: BuildEnvironment = {
  id: "windows-utm",
  triples: CONFIG.triples,

  available(): Promise<boolean> {
    return Promise.resolve(
      CONFIG.vmName !== "REPLACE_ME" &&
        CONFIG.ssh.host !== "REPLACE_ME" &&
        CONFIG.ssh.user !== "REPLACE_ME",
    );
  },

  async detectState(): Promise<EnvState> {
    try {
      const out = await utmctl(["status", CONFIG.vmName]).output();
      if (!out.success) return "ABSENT";
      const s = new TextDecoder().decode(out.stdout).trim().toLowerCase();
      return s.includes("started") ? "RUNNING" : "STOPPED";
    } catch {
      return "ABSENT";
    }
  },

  async ensureUp(): Promise<void> {
    const out = await utmctl(["start", CONFIG.vmName]).output();
    if (!out.success) throw new Error(`utmctl start ${CONFIG.vmName} failed`);
    // Poll SSH until the guest is reachable, with a hard timeout so a guest that
    // never comes up fails loudly (and is torn down by withEnvironment) rather
    // than hanging.
    const deadline = CONFIG.bootTimeoutSec;
    for (let waited = 0; waited < deadline; waited += 3) {
      if (await sshOk()) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`guest SSH not reachable within ${deadline}s of starting ${CONFIG.vmName}`);
  },

  async teardown(): Promise<void> {
    await utmctl(["stop", CONFIG.vmName]).output();
  },

  teardownSync(): void {
    try {
      new Deno.Command(CONFIG.utmctl, {
        args: ["stop", CONFIG.vmName],
        stdout: "null",
        stderr: "null",
      }).outputSync();
    } catch {
      /* best-effort */
    }
  },

  async buildCore(req: CoreBuildRequest): Promise<ArtifactBundle> {
    const records: ArtifactBundle["records"] = [];
    let version = "";
    // Forward-slash repo path for deno + scp (cmd `cd` needs the backslash form).
    const repoFwd = CONFIG.guestRepo.replace(/\\/g, "/");
    // `scp -r <dir> <dest>` copies INTO dest when it exists but creates dest from
    // the dir's contents when it doesn't. Ensure dist/ exists up front so every
    // scp nests as dist/<triple>/ rather than dumping the first one into dist/.
    await ensureDir(DIST_DIR);
    await syncSource();
    for (const triple of req.triples) {
      step(`utm build core for ${triple}`);
      const stageRel = `bundles/${this.id}-${triple}`;
      const guestBundleDir = `${repoFwd}/dist/${stageRel}`;
      const isX64 = triple.startsWith("x86_64");
      // Per-arch MSVC env + sherpa lib. The cmd shell has no MSVC env otherwise,
      // so the C-compiling deps (ring, bzip2-sys) would fail.
      //   arm64: native build; sherpa-onnx-sys's download map omits win-arm64, so
      //          point SHERPA_ONNX_LIB_DIR at the staged lib.
      //   x64:   cross build; `set SHERPA...=` with NO trailing space DELETES the
      //          var (an empty value would fail the crate), so the crate fetches
      //          the win-x64 lib it does map.
      const vcArch = isX64 ? "arm64_amd64" : "arm64";
      const sherpaEnv = isX64
        ? `set SHERPA_ONNX_LIB_DIR=&`
        : `set "SHERPA_ONNX_LIB_DIR=%SHERPA_ONNX_LIB_DIR_ARM64%" &`;
      // NOTE: assumes the repo is present at CONFIG.guestRepo (UTM shared folder
      // or synced in). Installer builds additionally need the Tauri signing key
      // injected into this SSH env and wiped after.
      const code = await ssh(
        `cd /d ${CONFIG.guestRepo} & ` +
          `call "${CONFIG.vcvarsall}" ${vcArch} >nul & ` +
          `${sherpaEnv} ` +
          `deno run -A scripts/build-release-bundle.ts ` +
          `--kind=core --channel=${req.channel} --target=${triple} --bundle-dir=${guestBundleDir}`,
      );
      if (code !== 0) throw new Error(`guest core build for ${triple} exited ${code}`);
      // Bring the artifacts + bundle home into the host dist/ layout compose expects.
      // scp -r nests if the local target already exists, so remove it first and
      // scp into the PARENT (scp -r then recreates <triple>/ from the remote dir).
      const localTriple = join(DIST_DIR, triple);
      await Deno.remove(localTriple, { recursive: true }).catch(() => {});
      if ((await scpFromGuest(`${repoFwd}/dist/${triple}`, DIST_DIR)) !== 0) {
        throw new Error(`scp artifacts for ${triple} failed`);
      }
      const localBundle = join(DIST_DIR, stageRel);
      await Deno.remove(localBundle, { recursive: true }).catch(() => {});
      await ensureDir(join(DIST_DIR, "bundles"));
      if ((await scpFromGuest(guestBundleDir, join(DIST_DIR, "bundles"))) !== 0) {
        throw new Error(`scp bundle for ${triple} failed`);
      }
      const bundle = await readBundle(localBundle);
      version = bundle.version;
      records.push(...bundle.records);
      ok(`${triple}: ${bundle.records.length} artifacts`);
    }
    return { version, channel: req.channel, triples: req.triples, records };
  },

  async buildClient(req: ClientBuildRequest): Promise<ClientDescriptor[]> {
    const descriptors: ClientDescriptor[] = [];
    const repoFwd = CONFIG.guestRepo.replace(/\\/g, "/");
    await ensureDir(DIST_DIR);
    await syncSource();
    // Build-time secrets injected into the guest cmd env: the Tauri minisign key
    // (so the MSI/NSIS carries the in-app-update `.sig`) + the public keys
    // envFromProcess/pubkey-reconciliation need. The Ed25519 trust-root PRIVATE
    // key never transits (manifest signing stays on the host). Base64 values hold
    // no cmd-special chars, so `set "VAR=value"` is safe. The new key has no
    // password (empty value -> cmd clears the var -> envFromProcess reads "").
    const s = req.secrets;
    const secretEnv =
      `set "TOMAT_SIGNING_PUBLIC_KEY_B64=${s.signingPublicKeyB64}" & ` +
      `set "TAURI_UPDATER_PUBLIC_KEY=${s.tauriPublicKey}" & ` +
      `set "TAURI_UPDATER_PRIVATE_KEY=${s.tauriPrivateKey}" & ` +
      `set "TAURI_UPDATER_PRIVATE_KEY_PASSWORD=${s.tauriPassword}" & `;
    for (const triple of req.triples) {
      step(`utm build client for ${triple}`);
      const stageRel = `bundles/${this.id}-client-${triple}`;
      const guestBundleDir = `${repoFwd}/dist/${stageRel}`;
      const isX64 = triple.startsWith("x86_64");
      // arm64: native (vcvars arm64). x64: cross (arm64_amd64). Tauri builds the
      // MSI + NSIS and emits the updater `.sig`; findClientBundle picks the signed
      // installer. WiX/NSIS are auto-downloaded by the bundler on first build.
      const vcArch = isX64 ? "arm64_amd64" : "arm64";
      const code = await ssh(
        `cd /d ${CONFIG.guestRepo} & ` +
          `call "${CONFIG.vcvarsall}" ${vcArch} >nul & ` +
          secretEnv +
          `deno run -A scripts/build-release-bundle.ts ` +
          `--kind=client --channel=${req.channel} --target=${triple} --bundle-dir=${guestBundleDir}`,
      );
      if (code !== 0) throw new Error(`guest client build for ${triple} exited ${code}`);
      // Bring the installer (+ .sig) + descriptor home into the host dist/ layout.
      const localTriple = join(DIST_DIR, triple);
      await Deno.remove(localTriple, { recursive: true }).catch(() => {});
      if ((await scpFromGuest(`${repoFwd}/dist/${triple}`, DIST_DIR)) !== 0) {
        throw new Error(`scp client artifacts for ${triple} failed`);
      }
      const localBundle = join(DIST_DIR, stageRel);
      await Deno.remove(localBundle, { recursive: true }).catch(() => {});
      await ensureDir(join(DIST_DIR, "bundles"));
      if ((await scpFromGuest(guestBundleDir, join(DIST_DIR, "bundles"))) !== 0) {
        throw new Error(`scp client descriptor for ${triple} failed`);
      }
      const descriptor = await readClientDescriptor(localBundle);
      descriptors.push(descriptor);
      ok(`${triple}: client ${descriptor.filename}`);
    }
    return descriptors;
  },
};
