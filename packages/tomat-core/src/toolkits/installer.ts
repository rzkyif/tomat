// Toolkit installer, split into two user-triggered phases:
//   Download: fetch tarball / copy folder -> validate tools.json -> upsert rows
//             (status 'downloaded'). The folder is left byte-identical to what
//             was downloaded; we never edit deno.json.
//   Install:  run `deno install` for any declared deps -> pin content hash ->
//             flip to status 'installed'.
//
// All Deno subprocesses run with DENO_DIR=~/.tomat/core/deno-cache, and
// `deno install --node-modules-dir=auto` lands node_modules + deno.lock in the
// toolkit folder, so everything stays under ~/.tomat/ without modifying the
// shipped deno.json.
//
// Caller passes an `EventSink` to receive install_log + install_done frames
// for forwarding to the requesting client over WS.

import { dirname, join } from "@std/path";
import { UntarStream } from "@std/tar/untar-stream";
import { encodeBase64 } from "@std/encoding/base64";
import { errMessage, parseToolsJson, type ToolsJson } from "@tomat/shared";
import { binPath } from "../paths.ts";
import { channel, paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { isWithin } from "../shared/fs-safety.ts";
import { getLogger } from "../shared/log.ts";

// Re-exported for callers/tests that import it from here; the implementation now
// lives in shared/fs-safety.ts so the download + install paths share one guard.
export { isWithin };
import { sha256Hex, toHex } from "../shared/hash.ts";
import { newJobId } from "../shared/ids.ts";
import { binaryName } from "../binaries/versions.ts";
import { hashToolkit } from "./hash.ts";
import { toolkitInstallPath, toolkitsRegistry } from "./registry.ts";
import { resolveVersion } from "./npm-registry.ts";
import {
  builtinCodebasePath,
  BUILTIN_TOOLKIT_ID,
  loadBuiltinToolkitManifest,
} from "./builtin-manifest.ts";

const log = getLogger("toolkit-installer");

export type InstallSource =
  | { source: "npm"; name: string; version?: string }
  | { source: "local"; path: string; slug: string }
  // The CDN-distributed built-in toolkit. Bytes are resolved at install time:
  // the codebase (dev), `preferLocalDir` if it exists (install-script-placed
  // files, used by first-boot seeding), else the signed CDN tarball.
  | { source: "builtin"; preferLocalDir?: string };

export interface InstallEventSink {
  log(jobId: string, id: string, stream: "stdout" | "stderr", line: string): void;
  done(jobId: string, id: string, ok: boolean, code: number): void;
}

export interface InstallStarted {
  jobId: string;
  toolkitId: string;
}

const NOOP_SINK: InstallEventSink = {
  log() {
    /* */
  },
  done() {
    /* */
  },
};

// A local-install slug becomes a filesystem path segment under the toolkits
// dir; constrain it to a safe identifier charset so it can't contain `.`/`..`
// or separators that would escape the dir.
const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Phase 1: acquire a toolkit's files (fetch/extract npm, copy the built-in, copy
// a local folder) WITHOUT installing deps or pinning the content hash. The row
// lands in status='downloaded'. The caller then triggers startInstallDeps.
export function startDownload(
  spec: InstallSource,
  sink: InstallEventSink = NOOP_SINK,
): InstallStarted {
  const jobId = newJobId();
  if (spec.source === "local" && !SLUG_RE.test(spec.slug)) {
    throw new AppError(
      "validation_error",
      `invalid toolkit slug "${spec.slug}"; allowed: ${SLUG_RE.source}`,
    );
  }
  const toolkitId = toolkitIdForSpec(spec);
  void runDownload(spec, toolkitId, jobId, sink)
    .then(() => sink.done(jobId, toolkitId, true, 0))
    .catch((err) => {
      log.error(`download ${toolkitId} failed: ${errMessage(err)}`);
      sink.done(jobId, toolkitId, false, 1);
    });
  return { jobId, toolkitId };
}

// Phase 2: install an already-downloaded toolkit's dependencies (deno install
// for any declared deno.json/package.json deps), pin the content hash, and flip
// the row to status='installed'.
export function startInstallDeps(
  toolkitId: string,
  sink: InstallEventSink = NOOP_SINK,
): InstallStarted {
  const jobId = newJobId();
  void runInstallDeps(toolkitId, jobId, sink)
    .then(() => sink.done(jobId, toolkitId, true, 0))
    .catch((err) => {
      log.error(`install ${toolkitId} failed: ${errMessage(err)}`);
      toolkitsRegistry().setLastError(toolkitId, `install failed: ${errMessage(err)}`);
      sink.done(jobId, toolkitId, false, 1);
    });
  return { jobId, toolkitId };
}

// Update: re-download the latest bytes THEN re-install deps under one job, so an
// updated toolkit lands back in status='installed'. Because the install path
// re-pins the content hash, a legitimate update never trips drift.
export function startUpdate(
  spec: InstallSource,
  sink: InstallEventSink = NOOP_SINK,
): InstallStarted {
  const jobId = newJobId();
  const toolkitId = toolkitIdForSpec(spec);
  void runDownload(spec, toolkitId, jobId, sink)
    .then(() => runInstallDeps(toolkitId, jobId, sink))
    .then(() => sink.done(jobId, toolkitId, true, 0))
    .catch((err) => {
      log.error(`update ${toolkitId} failed: ${errMessage(err)}`);
      sink.done(jobId, toolkitId, false, 1);
    });
  return { jobId, toolkitId };
}

function toolkitIdForSpec(spec: InstallSource): string {
  return spec.source === "npm"
    ? flattenNpmName(spec.name)
    : spec.source === "builtin"
      ? BUILTIN_TOOLKIT_ID
      : spec.slug;
}

async function runDownload(
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
    registerDownloaded(toolkitId, spec.source, version, installPath, parsed, toolsJsonHash);
    log.info(`downloaded ${toolkitId}@${version}`);
  } catch (err) {
    await rmrf(stagingPath);
    throw err;
  }
}

async function runInstallDeps(
  toolkitId: string,
  jobId: string,
  sink: InstallEventSink,
): Promise<void> {
  const registry = toolkitsRegistry();
  const tk = registry.get(toolkitId);
  if (!tk) throw new AppError("toolkit_not_found", `toolkit ${toolkitId} not found`);
  if (tk.status === "drift") {
    throw new AppError(
      "toolkit_hash_drift",
      `toolkit ${toolkitId} has drifted; confirm re-enable before installing`,
    );
  }
  // Install deps in place: the download already swapped the folder into its final
  // location, no worker can spawn against a not-yet-installed toolkit (so no
  // race), and node_modules + deno.lock are hash-excluded. No second swap.
  await installDeps(tk.installedPath, jobId, toolkitId, sink);
  // Pin the content hash AFTER deps land. node_modules + deno.lock are excluded
  // from the hash, so this equals the pristine downloaded content.
  const contentHash = await hashToolkit(tk.installedPath);
  registry.markInstalled(toolkitId, contentHash);
  log.info(`installed ${toolkitId}`);
}

// Register a locally dropped-in folder (already under the toolkits dir) as
// 'downloaded' WITHOUT copying or installing: validate its tools.json, upsert
// the row + tools. Used by Rescan. Never writes into the folder.
export async function registerLocalDownloaded(toolkitId: string): Promise<void> {
  const installPath = toolkitInstallPath(toolkitId);
  const toolsJsonText = await readOptional(join(installPath, "tools.json"));
  if (!toolsJsonText) {
    throw new AppError("no_tools_json", `no tools.json at root of ${toolkitId}`);
  }
  const parsed = parseToolsJsonOrThrow(toolsJsonText);
  const toolsJsonHash = await sha256Hex(toolsJsonText);
  registerDownloaded(toolkitId, "local", "local", installPath, parsed, toolsJsonHash);
}

function parseToolsJsonOrThrow(text: string): ToolsJson {
  let result: ReturnType<typeof parseToolsJson>;
  try {
    result = parseToolsJson(JSON.parse(text));
  } catch (err) {
    throw new AppError("invalid_tools_json", `invalid JSON in tools.json: ${err}`);
  }
  if (!result.ok) {
    throw new AppError("invalid_tools_json", result.message, { issues: result.issues });
  }
  return result.value;
}

function registerDownloaded(
  toolkitId: string,
  source: InstallSource["source"],
  version: string,
  installPath: string,
  parsed: ToolsJson,
  toolsJsonHash: string,
): void {
  const registry = toolkitsRegistry();
  registry.upsertToolkit({
    id: toolkitId,
    source,
    displayName: parsed.name,
    description: parsed.description,
    version,
    installedPath: installPath,
    toolsJsonHash,
    // Not pinned until install; download leaves the row in 'downloaded'.
    contentHash: "",
    status: "downloaded",
  });
  registry.replaceTools(
    toolkitId,
    parsed.tools.map((t) => ({
      toolkitId,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      triggers: t.triggers ?? [],
      fnExport: t.function,
      alwaysAvailable: t.alwaysAvailable ?? false,
      requiredPermissions: flattenPermissions(t.permissions),
    })),
  );
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

/** Install a toolkit's declared dependencies with `deno install`, when it
 *  declares any. `--node-modules-dir=auto` lands node_modules in the folder
 *  without us editing the shipped deno.json. Run from the install phase on the
 *  live folder. */
async function installDeps(
  dir: string,
  jobId: string,
  toolkitId: string,
  sink: InstallEventSink,
): Promise<void> {
  if (await hasDeclaredDeps(dir)) {
    await runDenoInstall(dir, jobId, toolkitId, sink);
  }
}

/** True when the toolkit declares dependencies in deno.json `imports`
 *  (npm:/jsr: specifiers) or package.json `dependencies`. Throws on an
 *  unparseable config rather than silently skipping its deps. */
async function hasDeclaredDeps(dir: string): Promise<boolean> {
  const denoText = await readOptional(join(dir, "deno.json"));
  if (denoText) {
    let cfg: { imports?: Record<string, string> };
    try {
      cfg = JSON.parse(denoText);
    } catch {
      throw new AppError("deps_install_failed", `unparseable deno.json in ${dir}`);
    }
    for (const spec of Object.values(cfg.imports ?? {})) {
      if (typeof spec === "string" && (spec.startsWith("npm:") || spec.startsWith("jsr:"))) {
        return true;
      }
    }
  }
  const pkgText = await readOptional(join(dir, "package.json"));
  if (pkgText) {
    let pkg: { dependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      throw new AppError("deps_install_failed", `unparseable package.json in ${dir}`);
    }
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) return true;
  }
  return false;
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

async function runDenoInstall(
  cwd: string,
  jobId: string,
  toolkitId: string,
  sink: InstallEventSink,
): Promise<void> {
  const denoBin = binPath(binaryName("deno"));
  // --node-modules-dir=auto lands node_modules in the toolkit folder without us
  // editing the shipped deno.json; DENO_DIR keeps the package cache under
  // ~/.tomat. --allow-scripts=false blocks npm postinstall hooks.
  const proc = new Deno.Command(denoBin, {
    args: ["install", "--allow-scripts=false", "--node-modules-dir=auto", "--quiet"],
    cwd,
    env: { DENO_DIR: paths().denoCacheDir },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  await Promise.all([
    pumpLines(proc.stdout, (line) => sink.log(jobId, toolkitId, "stdout", line)),
    pumpLines(proc.stderr, (line) => sink.log(jobId, toolkitId, "stderr", line)),
  ]);
  const status = await proc.status;
  if (!status.success) {
    throw new AppError(
      "deps_install_failed",
      `deno install exited ${status.code} for ${toolkitId}`,
    );
  }
}

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  fn: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) fn(line);
    }
  }
  if (buf.length > 0) fn(buf);
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

async function readOptional(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
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

export function flattenNpmName(name: string): string {
  // @scope/name -> @scope__name to land cleanly under toolkits/<id>/.
  return name.replace("/", "__");
}

// Flatten the per-kind permission object from tools.json into a single
// PermissionDecl[] for storage / grant key derivation.
export function flattenPermissions(
  perms: ToolsJson["tools"][number]["permissions"] | undefined,
): Array<import("@tomat/shared").PermissionDecl> {
  if (!perms) return [];
  const out: Array<import("@tomat/shared").PermissionDecl> = [];
  for (const n of perms.net ?? []) {
    out.push({
      kind: "net",
      host: n.host,
      ports: n.ports,
      reason: n.reason,
      optional: n.optional,
    });
  }
  for (const r of perms.read ?? []) {
    out.push({
      kind: "read",
      path: r.path,
      reason: r.reason,
      optional: r.optional,
    });
  }
  for (const w of perms.write ?? []) {
    out.push({
      kind: "write",
      path: w.path,
      reason: w.reason,
      optional: w.optional,
    });
  }
  for (const r of perms.run ?? []) {
    out.push({
      kind: "run",
      binary: r.binary,
      reason: r.reason,
      optional: r.optional,
    });
  }
  for (const e of perms.env ?? []) {
    out.push({
      kind: "env",
      key: e.key,
      reason: e.reason,
      optional: e.optional,
    });
  }
  for (const f of perms.ffi ?? []) {
    out.push({ kind: "ffi", reason: f.reason, optional: f.optional });
  }
  for (const s of perms.sys ?? []) {
    out.push({
      kind: "sys",
      flag: s.flag,
      reason: s.reason,
      optional: s.optional,
    });
  }
  return out;
}
