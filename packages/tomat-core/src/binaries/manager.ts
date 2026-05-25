// Binaries manager: download + extract + install the platform-specific
// archive for each binary kind referenced by the runtime-fetched manifest.
//
// Expected archive format: gzipped tar (.tar.gz) containing:
//   <kind>(.exe)   — the executable, placed at bin/<kind>(.exe)
//   lib/*          — shared libraries for this host's triple, placed at bin/lib/*
//
// Any other tree shape is rejected to keep the on-disk layout predictable.

import { UntarStream } from "@std/tar/untar-stream";
import { join } from "@std/path";
import type {
  BinaryKind,
  BinaryManifest,
  BinaryStatus,
  Triple,
} from "@tomat/shared";
import { BINARY_KINDS } from "@tomat/shared";
import { downloadManager } from "../downloads/manager.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { newJobId } from "../shared/ids.ts";
import { loadBinaryManifest } from "./manifest.ts";
import { binaryName, hostTriple } from "./versions.ts";

const log = getLogger("binaries");

export interface InstallResult {
  jobIds: string[];
}

/** Per-binary installed-version index. Updated on successful install /
 *  update so /api/v1/binaries/check can report what's actually on disk vs
 *  what the manifest currently publishes. */
async function readInstalledVersions(): Promise<Record<string, string>> {
  try {
    const text = await Deno.readTextFile(join(paths().binDir, "versions.json"));
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      log.warn(
        `could not read versions.json: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
  return {};
}

async function writeInstalledVersion(
  kind: BinaryKind,
  version: string,
): Promise<void> {
  const versions = await readInstalledVersions();
  versions[kind] = version;
  await Deno.writeTextFile(
    join(paths().binDir, "versions.json"),
    JSON.stringify(versions, null, 2) + "\n",
  );
}

export interface BinaryUpdateCheck {
  kind: BinaryKind;
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string;
  available: boolean;
}

export class BinariesManager {
  // List the install state of every known binary kind. Used by
  // GET /api/v1/binaries.
  async list(): Promise<BinaryStatus[]> {
    const manifest = await loadBinaryManifest().catch(() => null);
    const out: BinaryStatus[] = [];
    for (const kind of BINARY_KINDS) {
      const path = join(paths().binDir, binaryName(kind));
      const installed = await fileExists(path);
      const version = manifest?.binaries[kind]?.version ?? "unknown";
      out.push({
        kind,
        version,
        installed,
        path: installed ? path : undefined,
      });
    }
    return out;
  }

  // Compare installed binary versions to the manifest's currently-published
  // version. Drives the UpdateButton's "updates available" affordance.
  async check(): Promise<BinaryUpdateCheck[]> {
    const manifest = await loadBinaryManifest({ force: true });
    const versions = await readInstalledVersions();
    const out: BinaryUpdateCheck[] = [];
    for (const kind of BINARY_KINDS) {
      const path = join(paths().binDir, binaryName(kind));
      const installed = await fileExists(path);
      const installedVersion = versions[kind] ?? null;
      const latestVersion = manifest.binaries[kind]?.version ?? "unknown";
      // "available" means we should re-install: either the binary is
      // missing, or the recorded install version disagrees with the
      // manifest. An installed-but-version-unknown binary (pre-tracking)
      // is treated as "current" so we don't spam the user with phantom
      // updates after upgrading core.
      const available = !installed ||
        (installedVersion !== null && installedVersion !== latestVersion);
      out.push({
        kind,
        installed,
        installedVersion,
        latestVersion,
        available,
      });
    }
    return out;
  }

  // Install (or replace) the named binaries. If `kinds` is omitted, installs
  // every kind not currently present. Returns one jobId per kicked-off
  // download; progress streams over the WS via downloads.snapshot.
  async install(kinds?: BinaryKind[]): Promise<InstallResult> {
    const manifest = await loadBinaryManifest();
    const triple = hostTriple();
    const targets = kinds ?? await this.missingKinds();
    const jobIds: string[] = [];
    for (const kind of targets) {
      const job = this.kickoff(kind, manifest, triple);
      jobIds.push(job);
    }
    return { jobIds };
  }

  // Force-update a single binary to the manifest's currently-published
  // version. No client-side version pinning — the CDN publishes one version
  // per kind at a time, and that's what we install.
  async update(kind: BinaryKind): Promise<{ jobId: string }> {
    const manifest = await loadBinaryManifest({ force: true });
    const triple = hostTriple();
    const jobId = this.kickoff(kind, manifest, triple);
    return { jobId };
  }

  // Used by manager.start() / boot flow.
  async installMissing(): Promise<InstallResult> {
    const missing = await this.missingKinds();
    if (missing.length === 0) return { jobIds: [] };
    log.info(`installing missing binaries: ${missing.join(", ")}`);
    return await this.install(missing);
  }

  private async missingKinds(): Promise<BinaryKind[]> {
    const out: BinaryKind[] = [];
    for (const kind of BINARY_KINDS) {
      const path = join(paths().binDir, binaryName(kind));
      if (!(await fileExists(path))) out.push(kind);
    }
    return out;
  }

  private kickoff(
    kind: BinaryKind,
    manifest: BinaryManifest,
    triple: Triple,
  ): string {
    const entry = manifest.binaries[kind];
    if (!entry) {
      throw new AppError("binary_not_found", `kind ${kind} not in manifest`);
    }
    const platform = entry.platforms[triple];
    if (!platform) {
      throw new AppError(
        "binary_not_found",
        `kind ${kind} has no entry for triple ${triple}`,
      );
    }
    const jobId = newJobId();
    const stagingPath = join(paths().stagingDir, `${kind}-${jobId}.tar.gz`);

    // Run the download + extract in the background; the WS shows progress.
    void (async () => {
      try {
        const downloaded = await downloadManager().enqueue({
          source: platform.url,
          url: platform.url,
          relPath: `staging/${kind}-${jobId}.tar.gz`,
          destination: "binaries",
          groupId: `binary:${kind}`,
          sha256: platform.sha256,
        });
        log.info(`${kind}: downloaded to ${downloaded}`);
        await extractArchive(downloaded, paths().binDir, kind);
        await Deno.remove(downloaded);
        await writeInstalledVersion(kind, entry.version);
        log.info(`${kind}: installed v${entry.version}`);
      } catch (err) {
        log.error(
          `${kind}: install failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      } finally {
        try {
          await Deno.remove(stagingPath);
        } catch { /* fine */ }
      }
    })();
    return jobId;
  }
}

let _instance: BinariesManager | null = null;
export function binariesManager(): BinariesManager {
  if (!_instance) _instance = new BinariesManager();
  return _instance;
}

export function __resetForTesting(): void {
  _instance = null;
}

// --- archive extraction ----------------------------------------------------

// Extracts a .tar.gz at `archivePath` into `targetDir`. The archive must
// contain exactly two kinds of entries:
//   - the executable named `<kind>(.exe)` (placed at <targetDir>/<exeName>)
//   - any number of entries under `lib/` (placed at <targetDir>/lib/...)
// Anything else is rejected.
async function extractArchive(
  archivePath: string,
  targetDir: string,
  kind: BinaryKind,
): Promise<void> {
  const exeName = binaryName(kind);
  await Deno.mkdir(join(targetDir, "lib"), { recursive: true });

  const file = await Deno.open(archivePath, { read: true });
  const gunzip = new DecompressionStream("gzip");
  const entries = file.readable.pipeThrough(gunzip).pipeThrough(
    new UntarStream(),
  );

  let exeFound = false;
  for await (const entry of entries) {
    const name = entry.path;
    if (name === exeName) {
      await writeStreamTo(entry.readable, join(targetDir, exeName), 0o755);
      exeFound = true;
    } else if (name.startsWith("lib/")) {
      const out = join(targetDir, name);
      await Deno.mkdir(dirOf(out), { recursive: true });
      await writeStreamTo(entry.readable, out, 0o644);
    } else if (entry.header.typeflag === "5" /* directory */) {
      // ignore
      await entry.readable?.cancel();
    } else {
      await entry.readable?.cancel();
      throw new AppError(
        "extract_failed",
        `unexpected archive entry for ${kind}: ${name}`,
      );
    }
  }
  if (!exeFound) {
    throw new AppError(
      "extract_failed",
      `archive for ${kind} missing ${exeName}`,
    );
  }
}

async function writeStreamTo(
  stream: ReadableStream<Uint8Array> | undefined | null,
  outPath: string,
  mode: number,
): Promise<void> {
  if (!stream) {
    throw new AppError("extract_failed", `null stream for ${outPath}`);
  }
  const out = await Deno.open(outPath, {
    create: true,
    write: true,
    truncate: true,
  });
  try {
    await stream.pipeTo(out.writable);
  } finally {
    try {
      // out.writable.pipeTo closes the writable side, which closes the file.
      // Re-closing throws — swallow.
    } catch { /* fine */ }
  }
  if (Deno.build.os !== "windows") {
    await Deno.chmod(outPath, mode);
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.substring(0, i);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}
