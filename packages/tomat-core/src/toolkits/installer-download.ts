// Download phase: acquire a toolkit's files (fetch/extract an npm tarball, copy
// the built-in, or copy a local folder), validate tools.json, swap the folder
// into place, and register the rows (status 'downloaded') WITHOUT installing deps
// or pinning the content hash. The folder is left byte-identical to what was
// downloaded; we never edit deno.json. Tarballs are integrity-verified before
// extraction and every extracted path is constrained to the toolkit dir.
import { dirname, join } from "@std/path";
import { UntarStream } from "@std/tar/untar-stream";
import { encodeBase64 } from "@std/encoding/base64";
import { errMessage } from "@tomat/shared";
import { channel, paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { isWithin } from "../shared/fs-safety.ts";
import { getLogger } from "../shared/log.ts";
import { sha256Hex, toHex } from "../shared/hash.ts";
import { toolkitInstallPath } from "./registry.ts";
import { resolveVersion } from "./npm-registry.ts";
import {
  builtinCodebasePath,
  BUILTIN_TOOLKIT_ID,
  loadBuiltinToolkitManifest,
} from "./builtin-manifest.ts";
import { finishRegister, parseToolsJsonOrThrow } from "./installer-register.ts";
import {
  flattenNpmName,
  type InstallEventSink,
  type InstallSource,
  readOptional,
} from "./installer-shared.ts";

const log = getLogger("toolkit-installer");

// Phase 1: acquire a toolkit's files (fetch/extract npm, copy the built-in, copy
// a local folder) WITHOUT installing deps or pinning the content hash. The row
// lands in status='downloaded'. The caller then triggers startInstallDeps.
export async function runDownload(
  spec: InstallSource,
  toolkitId: string,
  jobId: string,
  sink: InstallEventSink,
): Promise<void> {
  const installPath = toolkitInstallPath(toolkitId);
  // Defense in depth: whatever the id resolves to must stay inside the toolkits
  // dir (covers the flattened-npm-name path too, not just the local slug).
  if (!isWithin(paths().toolkitsDir, installPath)) {
    throw new AppError(
      "validation_error",
      `toolkit "${toolkitId}" resolves outside the toolkits dir`,
    );
  }
  const stagingPath = installPath + ".new";
  await rmrf(stagingPath);

  try {
    // Extract/copy the bytes AS-IS (no deno.json edit). Deps are installed in
    // the separate install phase; the content hash is pinned there too.
    let version: string;
    if (spec.source === "npm") {
      version = await installNpm(spec, stagingPath, jobId, sink);
    } else if (spec.source === "builtin") {
      version = await installBuiltin(spec, stagingPath, jobId, sink);
    } else {
      await installLocal(spec, stagingPath);
      version = "local";
    }

    // Validate tools.json at the folder root (no code execution).
    const toolsJsonText = await readOptional(join(stagingPath, "tools.json"));
    if (!toolsJsonText) {
      throw new AppError("no_tools_json", `no tools.json at root of ${toolkitId}`);
    }
    const parsed = parseToolsJsonOrThrow(toolsJsonText);
    const toolsJsonHash = await sha256Hex(toolsJsonText);

    await swapIntoPlace(stagingPath, installPath, toolkitId);
    log.info(`downloaded ${toolkitId}@${version}`);
    // Register rows; a no-dep toolkit also finishes at 'installed' here.
    await finishRegister(toolkitId, spec.source, version, installPath, parsed, toolsJsonHash);
  } catch (err) {
    await rmrf(stagingPath);
    throw err;
  }
}

// Atomic swap: <id>.new -> <id>.old (if present) + <id>.new -> <id>, with
// rollback of the previous version if the final rename fails.
async function swapIntoPlace(
  stagingPath: string,
  installPath: string,
  toolkitId: string,
): Promise<void> {
  await rmrf(installPath + ".old");
  let hadOld = false;
  try {
    await Deno.stat(installPath);
    await Deno.rename(installPath, installPath + ".old");
    hadOld = true;
  } catch {
    /* fresh install */
  }
  try {
    await Deno.rename(stagingPath, installPath);
  } catch (err) {
    if (hadOld) {
      try {
        await Deno.rename(installPath + ".old", installPath);
      } catch (rollbackErr) {
        // The original install dir is now stranded at `installPath.old` and
        // there is no `installPath`. Log so the user can recover manually
        // (the outer error reporting only carries the primary failure).
        log.error(
          `${toolkitId}: rollback rename failed; previous version is at ` +
            `${installPath}.old: ${errMessage(rollbackErr)}`,
        );
      }
    }
    throw err;
  }
  await rmrf(installPath + ".old");
}

// --- npm path -------------------------------------------------------------

async function installNpm(
  spec: Extract<InstallSource, { source: "npm" }>,
  stagingPath: string,
  jobId: string,
  sink: InstallEventSink,
): Promise<string> {
  const resolved = await resolveVersion(spec.name, spec.version);
  sink.log(jobId, flattenNpmName(spec.name), "stdout", `resolved ${spec.name}@${resolved.version}`);

  await Deno.mkdir(stagingPath, { recursive: true });
  await fetchAndExtractTarball(resolved.tarballUrl, stagingPath, {
    integrity: resolved.integrity,
    shasum: resolved.shasum,
  });
  // Deps are NOT installed here; that is the separate install phase.
  return resolved.version;
}

// --- builtin path ---------------------------------------------------------

async function installBuiltin(
  spec: Extract<InstallSource, { source: "builtin" }>,
  stagingPath: string,
  jobId: string,
  sink: InstallEventSink,
): Promise<string> {
  // Resolve the latest version (and CDN tarball, when used) from the signed
  // manifest. In dev this is the codebase-derived dev manifest.
  const manifest = await loadBuiltinToolkitManifest();
  await Deno.mkdir(stagingPath, { recursive: true });

  if (channel() === "dev") {
    sink.log(jobId, BUILTIN_TOOLKIT_ID, "stdout", "installing built-in toolkit from codebase");
    await copyTreeExcludingNodeModules(builtinCodebasePath(), stagingPath);
  } else if (spec.preferLocalDir && (await dirExists(spec.preferLocalDir))) {
    sink.log(
      jobId,
      BUILTIN_TOOLKIT_ID,
      "stdout",
      `installing built-in toolkit from ${spec.preferLocalDir}`,
    );
    await copyTreeExcludingNodeModules(spec.preferLocalDir, stagingPath);
  } else {
    sink.log(
      jobId,
      BUILTIN_TOOLKIT_ID,
      "stdout",
      `downloading built-in toolkit ${manifest.version}`,
    );
    await fetchAndExtractTarball(manifest.tarballUrl, stagingPath, { sha256: manifest.sha256 });
  }

  // Deps run in the install phase like every other source; download just gets
  // the files into the folder.
  return manifest.version;
}

// --- local path -----------------------------------------------------------

async function installLocal(
  spec: Extract<InstallSource, { source: "local" }>,
  stagingPath: string,
): Promise<void> {
  // Copy the source tree AS-IS (excluding node_modules). No deno.json edit and
  // no deno install here: deps run in the install phase, and the folder is left
  // byte-identical to what the user placed.
  await Deno.mkdir(stagingPath, { recursive: true });
  await copyTreeExcludingNodeModules(spec.path, stagingPath);
}

// --- helpers --------------------------------------------------------------

async function fetchAndExtractTarball(
  url: string,
  targetDir: string,
  verify?: { integrity?: string; shasum?: string; sha256?: string },
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppError("tarball_fetch_failed", `npm tarball HTTP ${res.status} for ${url}`);
  }
  if (!res.body) {
    throw new AppError("tarball_fetch_failed", `empty tarball body for ${url}`);
  }
  // Verify the tarball BEFORE extraction so a tampered/MITM'd package can't
  // even reach the untar loop. We buffer the (small) tarball, check it against
  // npm's published SRI integrity (sha512) or, failing that, the legacy sha1
  // shasum, then extract from the verified bytes.
  const bytes = new Uint8Array(await res.arrayBuffer());
  await verifyTarball(bytes, url, verify);
  const gunzip = new DecompressionStream("gzip");
  const entries = new Blob([bytes]).stream().pipeThrough(gunzip).pipeThrough(new UntarStream());

  for await (const entry of entries) {
    const name = entry.path;
    // npm tarballs always begin with `package/`. Strip it.
    const stripped = name.startsWith("package/") ? name.slice("package/".length) : name;
    if (!stripped) {
      await entry.readable?.cancel();
      continue;
    }
    // Only regular files and directories are extracted. A malicious tarball
    // could otherwise ship a symlink/hardlink (typeflag "2"/"1") or device
    // node and use it to escape the staging dir or follow into a sensitive
    // path on a later write. ustar regular-file typeflags are "0" / "\0" / "".
    const kind = extractableEntryType(entry.header.typeflag);
    if (kind === null) {
      await entry.readable?.cancel();
      throw new AppError(
        "extract_failed",
        `tarball entry "${name}" has unsupported type ${JSON.stringify(
          entry.header.typeflag,
        )} (symlinks/hardlinks/devices are not allowed)`,
      );
    }
    const isDir = kind === "dir";
    const out = join(targetDir, stripped);
    // Zip-slip guard: the resolved destination MUST stay inside targetDir.
    // Without this, an entry like `package/../../../bin/tomat-core` would
    // overwrite arbitrary files the core can write (binaries, worker scripts,
    // the secrets vault).
    if (!isWithin(targetDir, out)) {
      await entry.readable?.cancel();
      throw new AppError("extract_failed", `tarball entry "${name}" escapes the toolkit directory`);
    }
    if (isDir) {
      await Deno.mkdir(out, { recursive: true });
      await entry.readable?.cancel();
      continue;
    }
    await Deno.mkdir(dirname(out), { recursive: true });
    const stream = entry.readable;
    if (!stream) continue;
    const file = await Deno.open(out, {
      create: true,
      write: true,
      truncate: true,
    });
    await stream.pipeTo(file.writable);
  }
}

/** ustar typeflag classification for tarball extraction. Regular files are
 *  "0"/"\0"/""; directories are "5". Anything else (symlink "2", hardlink "1",
 *  device/fifo) could escape the staging dir on a later write and is rejected.
 *  Exported for testing. */
export function extractableEntryType(typeflag: string): "file" | "dir" | null {
  if (typeflag === "5") return "dir";
  if (typeflag === "0" || typeflag === "\0" || typeflag === "") return "file";
  return null;
}

/** Verify a fetched npm tarball against npm's published integrity before it is
 *  extracted. Prefers the SRI `dist.integrity` (sha512); falls back to the
 *  legacy `dist.shasum` (sha1). When neither is available the tarball is left
 *  unverified (logged) rather than blocking the install. Exported for testing. */
export async function verifyTarball(
  bytes: Uint8Array,
  url: string,
  verify?: { integrity?: string; shasum?: string; sha256?: string },
): Promise<void> {
  // Plain sha256-hex (used by the built-in toolkit's signed manifest, which
  // pins the tarball hash directly rather than npm's SRI/shasum metadata).
  if (verify?.sha256) {
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
    const got = toHex(new Uint8Array(digest));
    if (got !== verify.sha256.toLowerCase()) {
      throw new AppError("checksum_mismatch", `tarball failed sha256 check for ${url}`);
    }
    return;
  }
  const sha512Entry = verify?.integrity?.split(/\s+/).find((s) => s.startsWith("sha512-"));
  if (sha512Entry) {
    const expected = sha512Entry.slice("sha512-".length);
    const digest = await crypto.subtle.digest("SHA-512", bytes.buffer as ArrayBuffer);
    const got = encodeBase64(new Uint8Array(digest));
    if (got !== expected) {
      throw new AppError(
        "checksum_mismatch",
        `npm tarball failed sha512 integrity check for ${url}`,
      );
    }
    return;
  }
  if (verify?.shasum) {
    const digest = await crypto.subtle.digest("SHA-1", bytes.buffer as ArrayBuffer);
    const got = toHex(new Uint8Array(digest));
    if (got !== verify.shasum.toLowerCase()) {
      throw new AppError("checksum_mismatch", `npm tarball failed sha1 checksum for ${url}`);
    }
    return;
  }
  log.warn(`npm tarball ${url} has no integrity/shasum metadata; installing unverified`);
}

async function copyTreeExcludingNodeModules(src: string, dst: string): Promise<void> {
  for await (const entry of Deno.readDir(src)) {
    if (entry.name === "node_modules") continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(d, { recursive: true });
      await copyTreeExcludingNodeModules(s, d);
    } else if (entry.isFile) {
      await Deno.copyFile(s, d);
    }
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function rmrf(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}
