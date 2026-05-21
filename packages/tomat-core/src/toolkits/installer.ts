// Toolkit installer: fetch tarball → extract to toolkit folder → run
// `deno install` for transitive deps → validate tools.json → hash →
// upsert registry rows.
//
// All Deno subprocesses run with DENO_DIR=~/.tomat/core/deno-cache and each
// toolkit's synthesized deno.json has `nodeModulesDir: "auto"` so installs
// stay entirely under ~/.tomat/.
//
// Caller passes an `EventSink` to receive install_log + install_done frames
// for forwarding to the requesting client over WS.

import { dirname, join } from "@std/path";
import { UntarStream } from "@std/tar/untar-stream";
import { parseToolsJson, type ToolsJson } from "@tomat/shared";
import { binPath } from "../paths.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { newJobId } from "../shared/ids.ts";
import { binaryName } from "../binaries/versions.ts";
import { hashToolkit } from "./hash.ts";
import { toolId, toolkitInstallPath, toolkitsRegistry } from "./registry.ts";
import { resolveVersion } from "./npmRegistry.ts";

const log = getLogger("toolkit-installer");

export type InstallSource =
  | { source: "npm"; name: string; version?: string }
  | { source: "local"; path: string; slug: string };

export interface InstallEventSink {
  log(
    jobId: string,
    id: string,
    stream: "stdout" | "stderr",
    line: string,
  ): void;
  done(jobId: string, id: string, ok: boolean, code: number): void;
}

export interface InstallStarted {
  jobId: string;
  toolkitId: string;
}

const NOOP_SINK: InstallEventSink = {
  log() {/* */},
  done() {/* */},
};

export function startInstall(
  spec: InstallSource,
  sink: InstallEventSink = NOOP_SINK,
): InstallStarted {
  const jobId = newJobId();
  const toolkitId = spec.source === "npm"
    ? flattenNpmName(spec.name)
    : spec.slug;
  // Run the install in the background; caller polls/streams via sink.
  void runInstall(spec, toolkitId, jobId, sink).catch((err) => {
    log.error(
      `install ${toolkitId} failed: ${
        err instanceof Error ? err.message : err
      }`,
    );
    sink.done(jobId, toolkitId, false, 1);
  });
  return { jobId, toolkitId };
}

async function runInstall(
  spec: InstallSource,
  toolkitId: string,
  jobId: string,
  sink: InstallEventSink,
): Promise<void> {
  const installPath = toolkitInstallPath(toolkitId);
  const stagingPath = installPath + ".new";
  await rmrf(stagingPath);

  try {
    if (spec.source === "npm") {
      await installNpm(spec, stagingPath, jobId, sink);
    } else {
      await installLocal(spec, stagingPath);
    }
  } catch (err) {
    await rmrf(stagingPath);
    sink.done(
      jobId,
      toolkitId,
      false,
      err instanceof AppError ? 1 : 2,
    );
    return;
  }

  // Validate tools.json at folder root.
  const toolsJsonText = await readOptional(join(stagingPath, "tools.json"));
  if (!toolsJsonText) {
    await rmrf(stagingPath);
    sink.done(jobId, toolkitId, false, 3);
    throw new AppError(
      "no_tools_json",
      `no tools.json at root of ${toolkitId}`,
    );
  }
  let parsed: ToolsJson;
  try {
    const result = parseToolsJson(JSON.parse(toolsJsonText));
    if (!result.ok) {
      throw new AppError("invalid_tools_json", result.message, {
        issues: result.issues,
      });
    }
    parsed = result.value;
  } catch (err) {
    await rmrf(stagingPath);
    sink.done(jobId, toolkitId, false, 4);
    if (err instanceof AppError) throw err;
    throw new AppError(
      "invalid_tools_json",
      `invalid JSON in tools.json: ${err}`,
    );
  }

  // Compute hashes.
  const toolsJsonHash = await sha256Hex(toolsJsonText);
  const contentHash = await hashToolkit(stagingPath);

  // Atomic swap: <id>.new -> <id>.old + <id>.new -> <id>
  await rmrf(installPath + ".old");
  let hadOld = false;
  try {
    await Deno.stat(installPath);
    await Deno.rename(installPath, installPath + ".old");
    hadOld = true;
  } catch { /* fresh install */ }
  try {
    await Deno.rename(stagingPath, installPath);
  } catch (err) {
    if (hadOld) {
      try {
        await Deno.rename(installPath + ".old", installPath);
      } catch { /* */ }
    }
    sink.done(jobId, toolkitId, false, 5);
    throw err;
  }
  await rmrf(installPath + ".old");

  // Upsert registry.
  const registry = toolkitsRegistry();
  const version = spec.source === "npm"
    ? (await resolveVersion(spec.name, spec.version)).version
    : "local";
  registry.upsertToolkit({
    id: toolkitId,
    source: spec.source === "npm" ? "npm" : "local",
    displayName: parsed.name,
    description: parsed.description,
    version,
    installedPath: installPath,
    toolsJsonHash,
    contentHash,
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

  sink.done(jobId, toolkitId, true, 0);
  log.info(`installed ${toolkitId}@${version}`);
  // Unused-var nudge: id helper kept around for callers.
  void toolId;
}

// --- npm path -------------------------------------------------------------

async function installNpm(
  spec: Extract<InstallSource, { source: "npm" }>,
  stagingPath: string,
  jobId: string,
  sink: InstallEventSink,
): Promise<void> {
  const resolved = await resolveVersion(spec.name, spec.version);
  sink.log(
    jobId,
    flattenNpmName(spec.name),
    "stdout",
    `resolved ${spec.name}@${resolved.version}`,
  );

  await Deno.mkdir(stagingPath, { recursive: true });
  await fetchAndExtractTarball(resolved.tarballUrl, stagingPath);

  // Synthesize a deno.json so node_modules lands per-toolkit.
  const denoJson = {
    nodeModulesDir: "auto" as const,
    lock: "./deno.lock",
  };
  await Deno.writeTextFile(
    join(stagingPath, "deno.json"),
    JSON.stringify(denoJson, null, 2),
  );

  // Run deno install if the package declared dependencies.
  const pkgPath = join(stagingPath, "package.json");
  const pkgText = await readOptional(pkgPath);
  if (pkgText) {
    let pkg: { dependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      throw new AppError("invalid_tools_json", "invalid package.json");
    }
    const hasDeps = pkg.dependencies &&
      Object.keys(pkg.dependencies).length > 0;
    if (hasDeps) {
      await runDenoInstall(stagingPath, jobId, flattenNpmName(spec.name), sink);
    }
  }
}

// --- local path -----------------------------------------------------------

async function installLocal(
  spec: Extract<InstallSource, { source: "local" }>,
  stagingPath: string,
): Promise<void> {
  // Copy spec.path tree into stagingPath, excluding node_modules.
  await Deno.mkdir(stagingPath, { recursive: true });
  await copyTreeExcludingNodeModules(spec.path, stagingPath);

  // Ensure deno.json has nodeModulesDir: "auto".
  const denoPath = join(stagingPath, "deno.json");
  let denoCfg: Record<string, unknown>;
  try {
    denoCfg = JSON.parse(await Deno.readTextFile(denoPath));
  } catch {
    denoCfg = {};
  }
  if (denoCfg.nodeModulesDir !== "auto") {
    denoCfg.nodeModulesDir = "auto";
    await Deno.writeTextFile(denoPath, JSON.stringify(denoCfg, null, 2));
  }

  // If package.json has deps, run deno install.
  const pkgText = await readOptional(join(stagingPath, "package.json"));
  if (pkgText) {
    const pkg = JSON.parse(pkgText) as {
      dependencies?: Record<string, string>;
    };
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      await runDenoInstall(stagingPath, "", spec.slug, NOOP_SINK);
    }
  }
}

// --- helpers --------------------------------------------------------------

async function fetchAndExtractTarball(
  url: string,
  targetDir: string,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppError(
      "tarball_fetch_failed",
      `npm tarball HTTP ${res.status} for ${url}`,
    );
  }
  if (!res.body) {
    throw new AppError("tarball_fetch_failed", `empty tarball body for ${url}`);
  }
  const gunzip = new DecompressionStream("gzip");
  const entries = res.body.pipeThrough(gunzip).pipeThrough(new UntarStream());

  for await (const entry of entries) {
    const name = entry.path;
    // npm tarballs always begin with `package/`. Strip it.
    const stripped = name.startsWith("package/")
      ? name.slice("package/".length)
      : name;
    if (!stripped) {
      await entry.readable?.cancel();
      continue;
    }
    const out = join(targetDir, stripped);
    if (entry.header.typeflag === "5" /* directory */) {
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

async function runDenoInstall(
  cwd: string,
  jobId: string,
  toolkitId: string,
  sink: InstallEventSink,
): Promise<void> {
  const denoBin = binPath(binaryName("deno"));
  const proc = new Deno.Command(denoBin, {
    args: ["install", "--allow-scripts=false", "--quiet"],
    cwd,
    env: { DENO_DIR: paths().denoCacheDir },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  await Promise.all([
    pumpLines(
      proc.stdout,
      (line) => sink.log(jobId, toolkitId, "stdout", line),
    ),
    pumpLines(
      proc.stderr,
      (line) => sink.log(jobId, toolkitId, "stderr", line),
    ),
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

async function copyTreeExcludingNodeModules(
  src: string,
  dst: string,
): Promise<void> {
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function rmrf(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

function flattenNpmName(name: string): string {
  // @scope/name -> @scope__name to land cleanly under toolkits/<id>/.
  return name.replace("/", "__");
}

// Flatten the per-kind permission object from tools.json into a single
// PermissionDecl[] for storage / grant key derivation.
function flattenPermissions(
  perms: ToolsJson["tools"][number]["permissions"],
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
