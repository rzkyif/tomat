// Registry writes shared by the download + rescan paths: upsert a freshly
// acquired extension's rows, and enforce the no-dep -> 'installed' rule (a extension
// declaring no deps has nothing to install, so it lands 'installed' immediately;
// one with deps stays 'downloaded' until the explicit Install step).
import { dirname, join } from "@std/path";
import { type ExtensionManifest, parseExtensionManifest } from "@tomat/shared";
import { memoriesStore } from "../services/memories-store.ts";
import { scheduleMemoryIndexing } from "../services/memories-indexer.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { sha256Hex } from "../shared/hash.ts";
import { hashExtension } from "./hash.ts";
import { extensionInstallPath, extensionsRegistry } from "./registry.ts";
import { hasDeclaredDeps } from "./installer-deps.ts";
import { type InstallSource, readOptional } from "./installer-shared.ts";

const log = getLogger("extension-installer");

// Register a freshly-acquired extension's rows (status 'downloaded', hash unpinned)
// and, when it declares NO dependencies, immediately pin its hash + flip it to
// 'installed' (there is nothing to install). Extensions WITH deps stay 'downloaded'
// until the explicit Install step runs deno install. Shared by the download +
// rescan paths so the no-dep -> installed rule holds everywhere. Never writes
// into the folder beyond the (hash-excluded) artifacts deno install would add.
export async function finishRegister(
  extensionId: string,
  source: InstallSource["source"],
  version: string,
  installPath: string,
  parsed: ExtensionManifest,
  manifestHash: string,
): Promise<void> {
  const deps = await hasDeclaredDeps(installPath);
  registerDownloaded(extensionId, source, version, installPath, parsed, manifestHash, deps);
  if (!deps) {
    const contentHash = await hashExtension(installPath);
    extensionsRegistry().markInstalled(extensionId, contentHash);
    log.info(`installed ${extensionId} (no deps)`);
  }
}

// Register a locally dropped-in folder (already under the extensions dir): validate
// its tomat.json, upsert the row + tools (no copy). Used by Rescan. A no-dep
// folder lands 'installed'; a deps-bearing one 'downloaded'. Never writes into
// the folder.
export async function registerLocalDownloaded(extensionId: string): Promise<void> {
  const installPath = extensionInstallPath(extensionId);
  const manifestText = await readOptional(join(installPath, "tomat.json"));
  if (!manifestText) {
    throw new AppError("no_tomat_json", `no tomat.json at root of ${extensionId}`);
  }
  const parsed = parseManifestOrThrow(manifestText);
  const manifestHash = await sha256Hex(manifestText);
  await finishRegister(extensionId, "local", "local", installPath, parsed, manifestHash);
}

export function parseManifestOrThrow(text: string): ExtensionManifest {
  let result: ReturnType<typeof parseExtensionManifest>;
  try {
    result = parseExtensionManifest(JSON.parse(text));
  } catch (err) {
    throw new AppError("invalid_tomat_json", `invalid JSON in tomat.json: ${err}`);
  }
  if (!result.ok) {
    throw new AppError("invalid_tomat_json", result.message, {
      issues: result.issues,
    });
  }
  return result.value;
}

function registerDownloaded(
  extensionId: string,
  source: InstallSource["source"],
  version: string,
  installPath: string,
  parsed: ExtensionManifest,
  manifestHash: string,
  hasDeps: boolean,
): void {
  const registry = extensionsRegistry();
  registry.upsertExtension({
    id: extensionId,
    source,
    displayName: parsed.displayName,
    description: parsed.description,
    version,
    installedPath: installPath,
    manifestHash,
    // Not pinned until install; download leaves the row in 'downloaded'.
    contentHash: "",
    status: "downloaded",
    hasDeps,
    hasDatabase: parsed.database,
  });
  registry.replaceTools(
    extensionId,
    parsed.tools.map((t) => ({
      extensionId,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      triggers: t.triggers ?? [],
      fnExport: t.function,
      alwaysAvailable: t.alwaysAvailable ?? false,
      platforms: t.platforms ?? [],
      requiredPermissions: flattenPermissions(t.permissions),
    })),
  );
  // Register any read-only memories the extension ships. The base dir is the
  // parent of the install dir so each row's `${extensionId}/${path}` filename
  // resolves back under the install dir (see registerExtensionMemories).
  memoriesStore().registerExtensionMemories(extensionId, dirname(installPath), parsed.memories);
  // Index the just-registered memories so a knowledge memory's summary +
  // embedding land now, rather than waiting for the next boot (skill memories
  // already carry their frontmatter summary). Matches the manual rescan path.
  scheduleMemoryIndexing();
}

// Flatten the per-kind permission object from tomat.json into a single
// PermissionDecl[] for storage / grant key derivation.
export function flattenPermissions(
  perms: ExtensionManifest["tools"][number]["permissions"] | undefined,
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
  for (const d of perms.memories ?? []) {
    out.push({
      kind: "memories",
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
