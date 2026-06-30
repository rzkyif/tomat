// Linux build environment: a Podman container, started on demand.
//
// Builds core + helpers + speech (buildCore) and the Tauri Linux desktop client
// `.deb` (buildClient) for x86_64-unknown-linux-gnu by CROSS-COMPILING from the
// NATIVE arm64 container (qemu-emulated rustc SIGSEGVs, so no amd64 emulation):
// rustc runs arm64 + emits x64; the GNU cross toolchain compiles/links the C deps;
// the client links the GUI libs against an amd64 sysroot baked into the image.
// See the Containerfile for the toolchain + sysroot setup.
//
// ============================ FILL THIS IN ============================
// Set these to match your machine, then flip the driver on by registering it in
// all-targets.ts. Until PODMAN_MACHINE is set, available() returns false and the
// driver is skipped.
const CONFIG = {
  // `podman machine list` -> the NAME column.
  machine: "podman-machine-default",
  // Image tag built from drivers/linux/Containerfile (see its header for the
  // `podman build` command). Must contain deno + the Rust linux targets + the
  // Tauri Linux deps + sherpa build deps.
  image: "tomat-linux-build:latest",
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
import { DIST_DIR, ok, REPO_ROOT, step } from "../lib.ts";
import type { BuildEnvironment, ClientBuildRequest, CoreBuildRequest, EnvState } from "./mod.ts";

// Only x86_64 is in the release matrix (linux-arm64 is dropped as niche for a
// desktop GUI). The container runs NATIVE arm64 and cross-compiles to x64 (see
// the Containerfile) - no emulation, so no qemu rustc crashes.
const LINUX_TRIPLES: Triple[] = ["x86_64-unknown-linux-gnu"];

async function podman(args: string[]): Promise<{ code: number; stdout: string }> {
  const out = await new Deno.Command("podman", {
    args,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
  };
}

async function hasPodman(): Promise<boolean> {
  try {
    return (
      await new Deno.Command("podman", {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output()
    ).success;
  } catch {
    return false;
  }
}

export const podmanLinuxDriver: BuildEnvironment = {
  id: "linux-podman",
  triples: LINUX_TRIPLES,

  async available(): Promise<boolean> {
    return CONFIG.machine !== "REPLACE_ME" && (await hasPodman());
  },

  async detectState(): Promise<EnvState> {
    const { code, stdout } = await podman([
      "machine",
      "inspect",
      CONFIG.machine,
      "--format",
      "{{.State}}",
    ]);
    if (code !== 0) return "ABSENT";
    return stdout.toLowerCase() === "running" ? "RUNNING" : "STOPPED";
  },

  async ensureUp(): Promise<void> {
    const { code } = await podman(["machine", "start", CONFIG.machine]);
    if (code !== 0) throw new Error(`podman machine start ${CONFIG.machine} failed`);
  },

  async teardown(): Promise<void> {
    await podman(["machine", "stop", CONFIG.machine]);
  },

  teardownSync(): void {
    try {
      new Deno.Command("podman", {
        args: ["machine", "stop", CONFIG.machine],
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
    // The rw bind-mount target must exist on the host (else podman creates it
    // root-owned, or the mount fails); the build writes artifacts + bundle here.
    await ensureDir(DIST_DIR);
    for (const triple of req.triples) {
      step(`podman build core for ${triple}`);
      // Per-triple staging dir under dist/ (a nested rw mount over the ro repo),
      // so artifacts + bundle.json land directly on the host with no podman cp.
      const stageRel = `bundles/${this.id}-${triple}`;
      const { code } = await podman([
        "run",
        "--rm",
        "-v",
        `${REPO_ROOT}:/work:ro`,
        // Writable dist overlaid on the read-only repo: builds write here, the
        // host reads here. cargo's target dir is sent to /tmp (writable, fast).
        "-v",
        `${DIST_DIR}:/work/dist:rw`,
        "-e",
        "CARGO_TARGET_DIR=/tmp/target",
        "-w",
        "/work",
        CONFIG.image,
        "deno",
        "run",
        "-A",
        "scripts/build-release-bundle.ts",
        "--kind=core",
        `--channel=${req.channel}`,
        `--target=${triple}`,
        `--bundle-dir=/work/dist/${stageRel}`,
      ]);
      if (code !== 0) throw new Error(`podman core build for ${triple} exited ${code}`);
      const bundle = await readBundle(join(DIST_DIR, stageRel));
      version = bundle.version;
      records.push(...bundle.records);
      ok(`${triple}: ${bundle.records.length} artifacts`);
    }
    return { version, channel: req.channel, triples: req.triples, records };
  },

  async buildClient(req: ClientBuildRequest): Promise<ClientDescriptor[]> {
    await ensureDir(DIST_DIR);
    const descriptors: ClientDescriptor[] = [];
    for (const triple of req.triples) {
      step(`podman build client (.deb) for ${triple}`);
      const stageRel = `bundles/${this.id}-client-${triple}`;
      const { code } = await podman([
        "run",
        "--rm",
        // Unlike the core build, the Tauri/vite frontend build writes into the
        // repo tree (build/, .svelte-kit/, node_modules/), so the client build
        // needs a WRITABLE repo mount. cargo + the Tauri bundler write to
        // /tmp/target (findClientBundle honors CARGO_TARGET_DIR); the .deb lands
        // on the host via the writable mount under dist/.
        "-v",
        `${REPO_ROOT}:/work:rw`,
        "-e",
        "CARGO_TARGET_DIR=/tmp/target",
        // Cross-link the GUI app against the amd64 sysroot baked into the image
        // (webkit2gtk/gtk/soup/...). Overrides the core build's multiarch-dbus
        // pkg-config + plain cross gcc with sysroot-scoped equivalents, so the
        // x86_64 Tauri client resolves the webkit headers/libs the multiarch -dev
        // route can't provide. Client-only: the core build keeps the image env.
        "-e",
        "PKG_CONFIG_SYSROOT_DIR_x86_64_unknown_linux_gnu=/opt/amd64-sysroot",
        "-e",
        "PKG_CONFIG_PATH_x86_64_unknown_linux_gnu=/opt/amd64-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/opt/amd64-sysroot/usr/share/pkgconfig",
        "-e",
        "CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc --sysroot=/opt/amd64-sysroot",
        "-e",
        "CXX_x86_64_unknown_linux_gnu=x86_64-linux-gnu-g++ --sysroot=/opt/amd64-sysroot",
        "-e",
        "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C link-arg=--sysroot=/opt/amd64-sysroot",
        // Public keys only: the .deb has no Tauri updater .sig, so no private key
        // ever enters the container (its first-install is sha256 + Ed25519-gated).
        "-e",
        `TOMAT_SIGNING_PUBLIC_KEY_B64=${req.secrets.signingPublicKeyB64}`,
        "-e",
        `TAURI_UPDATER_PUBLIC_KEY=${req.secrets.tauriPublicKey}`,
        "-w",
        "/work",
        CONFIG.image,
        "deno",
        "run",
        "-A",
        "scripts/build-release-bundle.ts",
        "--kind=client",
        `--channel=${req.channel}`,
        `--target=${triple}`,
        "--bundles=deb",
        `--bundle-dir=/work/dist/${stageRel}`,
      ]);
      if (code !== 0) throw new Error(`podman client build for ${triple} exited ${code}`);
      const descriptor = await readClientDescriptor(join(DIST_DIR, stageRel));
      descriptors.push(descriptor);
      ok(`${triple}: client ${descriptor.filename}`);
    }
    return descriptors;
  },
};
