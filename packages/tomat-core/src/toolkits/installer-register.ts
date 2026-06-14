// Registry writes shared by the download + rescan paths: upsert a freshly
// acquired toolkit's rows, and enforce the no-dep -> 'installed' rule (a toolkit
// declaring no deps has nothing to install, so it lands 'installed' immediately;
// one with deps stays 'downloaded' until the explicit Install step).
import { join } from "@std/path";
import { parseToolsJson, type ToolsJson } from "@tomat/shared";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { sha256Hex } from "../shared/hash.ts";
import { hashToolkit } from "./hash.ts";
import { toolkitInstallPath, toolkitsRegistry } from "./registry.ts";
import { hasDeclaredDeps } from "./installer-deps.ts";
import { type InstallSource, readOptional } from "./installer-shared.ts";

const log = getLogger("toolkit-installer");

// Register a freshly-acquired toolkit's rows (status 'downloaded', hash unpinned)
// and, when it declares NO dependencies, immediately pin its hash + flip it to
// 'installed' (there is nothing to install). Toolkits WITH deps stay 'downloaded'
// until the explicit Install step runs deno install. Shared by the download +
// rescan paths so the no-dep -> installed rule holds everywhere. Never writes
// into the folder beyond the (hash-excluded) artifacts deno install would add.
export async function finishRegister(
  toolkitId: string,
  source: InstallSource["source"],
  version: string,
  installPath: string,
  parsed: ToolsJson,
  toolsJsonHash: string,
): Promise<void> {
  const deps = await hasDeclaredDeps(installPath);
  registerDownloaded(toolkitId, source, version, installPath, parsed, toolsJsonHash, deps);
  if (!deps) {
    const contentHash = await hashToolkit(installPath);
    toolkitsRegistry().markInstalled(toolkitId, contentHash);
    log.info(`installed ${toolkitId} (no deps)`);
  }
}

// Register a locally dropped-in folder (already under the toolkits dir): validate
// its tools.json, upsert the row + tools (no copy). Used by Rescan. A no-dep
// folder lands 'installed'; a deps-bearing one 'downloaded'. Never writes into
// the folder.
export async function registerLocalDownloaded(toolkitId: string): Promise<void> {
  const installPath = toolkitInstallPath(toolkitId);
  const toolsJsonText = await readOptional(join(installPath, "tools.json"));
  if (!toolsJsonText) {
    throw new AppError("no_tools_json", `no tools.json at root of ${toolkitId}`);
  }
  const parsed = parseToolsJsonOrThrow(toolsJsonText);
  const toolsJsonHash = await sha256Hex(toolsJsonText);
  await finishRegister(toolkitId, "local", "local", installPath, parsed, toolsJsonHash);
}

export function parseToolsJsonOrThrow(text: string): ToolsJson {
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
  hasDeps: boolean,
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
    hasDeps,
    hasDatabase: parsed.database,
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
  for (const d of perms.documents ?? []) {
    out.push({
      kind: "documents",
      access: d.access,
      reason: d.reason,
      optional: d.optional,
    });
  }
  for (const m of perms.llm ?? []) {
    out.push({ kind: "llm", reason: m.reason, optional: m.optional });
  }
  for (const m of perms.tts ?? []) {
    out.push({ kind: "tts", reason: m.reason, optional: m.optional });
  }
  for (const m of perms.stt ?? []) {
    out.push({ kind: "stt", reason: m.reason, optional: m.optional });
  }
  return out;
}
