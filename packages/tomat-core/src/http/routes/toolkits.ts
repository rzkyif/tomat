import { Hono } from "hono";
import { join } from "@std/path";
import { z } from "zod";
import { errMessage, type Grant, parseToolsJson, permissionKey, type Tool } from "@tomat/shared";
import {
  type InstallEventSink,
  registerLocalDownloaded,
  startDownload,
  startInstallDeps,
  startUpdate,
} from "../../toolkits/installer.ts";
import { toolkitsRegistry } from "../../toolkits/registry.ts";
import { hashToolkit } from "../../toolkits/hash.ts";
import { workerPool } from "../../toolkits/worker-pool.ts";
import { deleteToolkit, uninstallToolkit } from "../../toolkits/uninstall.ts";
import { paths } from "../../paths.ts";
import {
  resolveLatestVersion,
  resolveVersion,
  searchPackages,
} from "../../toolkits/npm-registry.ts";
import { loadBuiltinToolkitManifest } from "../../toolkits/builtin-manifest.ts";
import { embed, isEmbeddingModelReady } from "../../services/embedding.ts";
import { toolFilter } from "../../services/tool-filter.ts";
import { sha256Hex } from "../../shared/hash.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";
import { wsHub } from "../../ws/hub.ts";
import { getLogger } from "../../shared/log.ts";

const log = getLogger("toolkits.routes");

// Sink that broadcasts install_log + install_done frames to every paired
// client. The client's toolkits state subscribes to these and renders
// streamed progress in the install modal. install_done also triggers a
// `toolkit.snapshot` so the installed list refreshes without polling.
export const BROADCAST_SINK: InstallEventSink = {
  log(jobId, id, stream, line) {
    wsHub().broadcastAll({
      kind: "toolkit.install_log",
      jobId,
      id,
      stream,
      line,
    });
  },
  done(jobId, id, ok, code) {
    wsHub().broadcastAll({
      kind: "toolkit.install_done",
      jobId,
      id,
      ok,
      code,
    });
    wsHub().broadcastAll({ kind: "toolkit.snapshot" });
  },
};

export function toolkitsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", (c) => c.json(toolkitsRegistry().list()));

  r.get("/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = numQuery(c, "limit", 50);
    const offset = numQuery(c, "offset", 0);
    return c.json({ results: await searchPackages(q, limit, offset) });
  });

  // Phase 1: acquire a toolkit's files (npm tarball / built-in / local folder).
  // Deps are NOT installed here; the toolkit lands in status 'downloaded'.
  r.post("/download", async (c) => {
    const body = (await readJson(c)) as
      | { source: "npm"; name: string; version?: string }
      | { source: "local"; path: string; slug?: string }
      | { source: "builtin" };
    if (body.source === "npm") {
      return c.json(startDownload(body, BROADCAST_SINK));
    } else if (body.source === "local") {
      if (!body.slug) {
        throw new AppError("validation_error", "slug required for local");
      }
      return c.json(
        startDownload({ source: "local", path: body.path, slug: body.slug }, BROADCAST_SINK),
      );
    } else if (body.source === "builtin") {
      return c.json(startDownload({ source: "builtin" }, BROADCAST_SINK));
    }
    throw new AppError("validation_error", "unknown source");
  });

  // Phase 2: install a downloaded toolkit's dependencies, pin its content hash,
  // and flip it to status 'installed' so its tools can be enabled.
  r.post("/:id/install", (c) => {
    const id = c.req.param("id");
    const tk = toolkitsRegistry().getOrThrow(id);
    if (tk.status === "drift") {
      throw new AppError("toolkit_hash_drift", `${id} content drift; confirm re-enable first`);
    }
    return c.json(startInstallDeps(id, BROADCAST_SINK));
  });

  // Check installed toolkits for newer versions (npm `dist-tags.latest`, the
  // built-in's signed manifest; local toolkits have no upstream). Per-toolkit
  // errors are isolated so one unreachable registry doesn't fail the batch.
  r.post("/check-updates", async (c) => c.json(await checkUpdates(await readJson(c))));

  // Reconcile the toolkits directory with the registry: register folders the
  // user dropped in (as 'downloaded'), re-register ones whose tools.json changed
  // (resetting them to 'downloaded' so the user re-Installs), and prune local
  // toolkits whose folder is gone. Rescan never installs deps or pins a hash;
  // that is the per-toolkit Install step. The toolkit.snapshot broadcast repaints
  // the client.
  r.post("/rescan", async (c) => c.json(await rescanToolkits()));

  // Delete: remove the toolkit's files + rows entirely. Allowed once a toolkit is
  // "uninstalled" (status 'downloaded'), in a 'drift' state, or for a no-dep
  // toolkit (which is delete-only). The snapshot repaints the client list.
  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await deleteToolkit(id);
    wsHub().broadcastAll({ kind: "toolkit.snapshot" });
    return c.body(null, 204);
  });

  // Uninstall: revert an installed, deps-bearing toolkit to 'downloaded' (drop
  // node_modules + deno.lock, unpin the hash). Source files stay for a re-Install.
  r.post("/:id/uninstall", async (c) => {
    const id = c.req.param("id");
    await uninstallToolkit(id);
    wsHub().broadcastAll({ kind: "toolkit.snapshot" });
    return c.json({ id });
  });

  r.post("/:id/update", async (c) => {
    const id = c.req.param("id");
    const toolkit = toolkitsRegistry().getOrThrow(id);
    const body = (await readJson(c)) as { version?: string };
    if (toolkit.source === "builtin") {
      // Re-download + re-install from the latest CDN manifest (same id). The
      // install path re-pins the hash, so a legitimate update never trips drift.
      return c.json(startUpdate({ source: "builtin" }, BROADCAST_SINK));
    }
    if (toolkit.source !== "npm") {
      throw new AppError("validation_error", "only npm and built-in toolkits can be updated");
    }
    const npmName = id.replace("__", "/");
    const resolved = await resolveVersion(npmName, body.version);
    return c.json(
      startUpdate({ source: "npm", name: npmName, version: resolved.version }, BROADCAST_SINK),
    );
  });

  r.get("/:id/tools", async (c) => {
    const id = c.req.param("id");
    const tools = toolkitsRegistry().listTools(id);
    const enriched = await Promise.all(tools.map((t) => attachRequiredPermissions(t)));
    return c.json({ tools: enriched });
  });

  r.post("/:id/tools/:tool/enable", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("tool");
    const tk = toolkitsRegistry().getOrThrow(id);
    if (tk.status === "drift") {
      throw new AppError("toolkit_hash_drift", `${id} content drift; confirm re-enable first`);
    }
    const tool = toolkitsRegistry()
      .listTools(id)
      .find((t) => t.name === name);
    if (!tool) throw new AppError("tool_not_found", `${id}::${name}`);
    // Enabling is allowed even with ungranted required permissions: the tool is
    // then "enabled but not exposed" (a warning state in the UI). chat.ts's
    // exposure gate is the authority on what the model actually sees.
    toolkitsRegistry().setToolEnabled(id, name, true);
    await workerPool().refreshPermissions(id);
    // Repaint the list so the "N enabled" badge reflects the change.
    wsHub().broadcastAll({ kind: "toolkit.snapshot" });
    return c.json({ ok: true });
  });

  r.post("/:id/tools/:tool/disable", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("tool");
    toolkitsRegistry().setToolEnabled(id, name, false);
    await workerPool().refreshPermissions(id);
    // Repaint the list so the "N enabled" badge reflects the change.
    wsHub().broadcastAll({ kind: "toolkit.snapshot" });
    return c.json({ ok: true });
  });

  // Confirm-reenable: the user reviewed an out-of-band content change and trusts
  // the current on-disk content. Re-pin the hash, clear drift, return to
  // 'installed'. Tools were disabled when drift was flagged; the user re-enables.
  r.post("/:id/confirm-reenable", async (c) => {
    const id = c.req.param("id");
    const tk = toolkitsRegistry().getOrThrow(id);
    const hash = await hashToolkit(tk.installedPath);
    toolkitsRegistry().repinAndClear(id, hash);
    return c.json({ id });
  });

  r.post("/:id/tools/:tool/grants", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("tool");
    const tool = toolkitsRegistry()
      .listTools(id)
      .find((t) => t.name === name);
    if (!tool) throw new AppError("tool_not_found", `${id}::${name}`);
    const body = (await readJson(c)) as {
      grants: Array<{ key: string; state: Grant["state"] }>;
    };
    if (!Array.isArray(body.grants)) {
      throw new AppError("validation_error", "grants array required");
    }
    const enriched = await attachRequiredPermissions(tool);
    const decoded = body.grants.map((g) => {
      const decl = enriched.requiredPermissions.find((p) => permissionKey(p) === g.key);
      if (!decl) {
        throw new AppError(
          "validation_error",
          `grant key ${g.key} not in this tool's required permissions`,
        );
      }
      if (g.state !== "granted" && g.state !== "ask" && g.state !== "denied") {
        throw new AppError("validation_error", `invalid grant state ${g.state}`);
      }
      return { key: g.key, kind: decl.kind, state: g.state };
    });
    const next = toolkitsRegistry().setGrants(tool.id, decoded);
    await workerPool().refreshPermissions(id);
    return c.json({ grants: next });
  });

  r.post("/:id/undeclared-policy", async (c) => {
    const id = c.req.param("id");
    toolkitsRegistry().getOrThrow(id);
    const body = (await readJson(c)) as { policy?: string };
    if (body.policy !== "deny" && body.policy !== "ask") {
      throw new AppError("validation_error", "policy must be 'deny' or 'ask'");
    }
    toolkitsRegistry().setUndeclaredPolicy(id, body.policy);
    await workerPool().refreshPermissions(id);
    return c.json(toolkitsRegistry().getOrThrow(id));
  });

  r.post("/reindex", async (c) => {
    // Tool-relevance RAG needs the embed model. If it isn't downloaded yet,
    // skip cleanly (embedded: 0) rather than letting embed() throw an opaque
    // worker error; the requirements flow prompts the download separately.
    if (!(await isEmbeddingModelReady())) {
      return c.json({ embedded: 0, skipped: true });
    }
    let count = 0;
    const tools = allEnabledTools();
    for (const t of tools) {
      const text = `${t.description}\n${(t.triggers ?? []).join("\n")}`;
      const [v] = await embed([text]);
      if (v) {
        toolkitsRegistry().storeEmbedding(t.id, v, await sha256Hex(text));
        count++;
      }
    }
    return c.json({ embedded: count });
  });

  r.post("/filter", async (c) => {
    const body = (await readJson(c)) as { vector: number[]; topK?: number };
    if (!Array.isArray(body.vector)) {
      throw new AppError("validation_error", "vector array required");
    }
    const result = toolFilter().phase1(new Float32Array(body.vector), {
      topK: body.topK,
      includeAlwaysAvailable: true,
    });
    return c.json(result);
  });

  const toolSchemasBodySchema = z
    .object({
      ids: z.array(z.string().min(1)).max(512),
    })
    .strict();

  r.post("/tool-schemas", async (c) => {
    const raw = await readJson(c);
    const parsed = toolSchemasBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const tools = parsed.data.ids.map((id) => {
      const tool = toolkitsRegistry().getTool(id);
      if (!tool) throw new AppError("tool_not_found", id);
      return {
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      };
    });
    return c.json({ tools });
  });

  r.post("/embed", async (c) => {
    const body = (await readJson(c)) as { texts: string[] };
    if (!Array.isArray(body.texts)) {
      throw new AppError("validation_error", "texts array required");
    }
    if (!(await isEmbeddingModelReady())) {
      throw new AppError("server_unavailable", "embedding model not downloaded yet");
    }
    const vectors = await embed(body.texts);
    return c.json({ vectors: vectors.map((v) => Array.from(v)) });
  });

  return r;
}

/** Toolkit directory ids present on disk, skipping the `.new` / `.old` staging
 *  dirs the installer creates during an atomic swap. */
async function listToolkitDirIds(): Promise<string[]> {
  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(paths().toolkitsDir)) {
      if (!entry.isDirectory) continue;
      if (entry.name.endsWith(".new") || entry.name.endsWith(".old")) continue;
      ids.push(entry.name);
    }
  } catch {
    // toolkitsDir does not exist yet: treat as empty.
  }
  return ids;
}

async function readToolkitToolsJson(id: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(join(paths().toolkitsDir, id, "tools.json"));
  } catch {
    return null;
  }
}

async function checkUpdates(
  body: unknown,
): Promise<{ results: import("@tomat/shared").ToolkitUpdateStatus[] }> {
  const ids = (body as { ids?: unknown })?.ids;
  const all = toolkitsRegistry().list();
  const targets = Array.isArray(ids) ? all.filter((t) => (ids as unknown[]).includes(t.id)) : all;

  const results: import("@tomat/shared").ToolkitUpdateStatus[] = [];
  // Sequential to stay polite to the npm registry; only installed npm/builtin
  // toolkits hit the network, and a per-toolkit failure is isolated.
  for (const tk of targets) {
    const base = { id: tk.id, installedVersion: tk.version };
    if (tk.source === "local") {
      results.push({ ...base, latestVersion: null, updateAvailable: false });
      continue;
    }
    try {
      const latestVersion =
        tk.source === "builtin"
          ? (await loadBuiltinToolkitManifest({ force: true })).version
          : await resolveLatestVersion(tk.id.replace("__", "/"));
      results.push({
        ...base,
        latestVersion,
        updateAvailable: latestVersion !== tk.version,
      });
    } catch (err) {
      results.push({
        ...base,
        latestVersion: null,
        updateAvailable: false,
        error: errMessage(err),
      });
    }
  }
  return { results };
}

async function rescanToolkits(): Promise<{ added: number; updated: number; removed: number }> {
  const ids = await listToolkitDirIds();
  const onDisk = new Set(ids);
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const id of ids) {
    const toolsJsonText = await readToolkitToolsJson(id);
    if (!toolsJsonText) continue; // a stray folder without a tools.json: ignore.
    const existing = toolkitsRegistry().get(id);
    // Only (re)register when new or when tools.json changed (cheap heuristic; a
    // code-only edit with an unchanged tools.json is left alone). Re-registering
    // resets the row to 'downloaded' so the user must re-Install before its tools
    // run. One folder with invalid tools.json must not fail the whole rescan.
    if (existing && (await sha256Hex(toolsJsonText)) === existing.toolsJsonHash) continue;
    try {
      await registerLocalDownloaded(id);
      if (existing) updated++;
      else added++;
    } catch (err) {
      log.warn(`rescan: skipping ${id}: ${errMessage(err)}`);
    }
  }

  // Prune local toolkits whose folder was removed from disk.
  for (const tk of toolkitsRegistry().list()) {
    if (tk.source === "local" && !onDisk.has(tk.id)) {
      await workerPool().refreshPermissions(tk.id);
      toolkitsRegistry().delete(tk.id);
      removed++;
    }
  }

  // Repaint clients now; each started install also fires its own snapshot on done.
  wsHub().broadcastAll({ kind: "toolkit.snapshot" });
  return { added, updated, removed };
}

function allEnabledTools(): Array<{
  id: string;
  description: string;
  triggers: string[];
}> {
  // Cheap query straight to the tools table; toolFilter has a richer version.
  // Duplicated here to avoid importing tool-filter.ts internals.
  const list = toolkitsRegistry()
    .list()
    .filter((t) => t.status === "installed");
  const out: Array<{ id: string; description: string; triggers: string[] }> = [];
  for (const tk of list) {
    for (const t of toolkitsRegistry().listTools(tk.id)) {
      if (t.enabled) {
        out.push({
          id: t.id,
          description: t.description,
          triggers: t.triggers,
        });
      }
    }
  }
  return out;
}

async function attachRequiredPermissions(tool: Tool): Promise<Tool> {
  const toolkit = toolkitsRegistry().getOrThrow(tool.toolkitId);
  const toolsJsonPath = join(toolkit.installedPath, "tools.json");
  try {
    const parsed = parseToolsJson(JSON.parse(await Deno.readTextFile(toolsJsonPath)));
    if (!parsed.ok) throw new AppError("invalid_tools_json", parsed.message);
    const def = parsed.value.tools.find((t) => t.name === tool.name);
    if (!def) {
      return { ...tool, requiredPermissions: [], missingRequired: [] };
    }
    const required = flattenPermissions(def.permissions);
    // Informational only: indices with no explicit decision yet (no grant
    // row in any state). An absent row behaves as 'ask' at runtime.
    const decidedKeys = new Set(tool.grants.map((g) => g.permissionKey));
    const missing: number[] = [];
    for (let i = 0; i < required.length; i++) {
      if (required[i].optional) continue;
      if (!decidedKeys.has(permissionKey(required[i]))) missing.push(i);
    }
    return { ...tool, requiredPermissions: required, missingRequired: missing };
  } catch (err) {
    if (err instanceof AppError) throw err;
    return { ...tool, requiredPermissions: [], missingRequired: [] };
  }
}

function flattenPermissions(
  perms: import("@tomat/shared").ToolsJson["tools"][number]["permissions"],
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

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}

function numQuery(c: import("hono").Context, key: string, def: number): number {
  const v = c.req.query(key);
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
