import { Hono } from "hono";
import { join } from "@std/path";
import {
  type Grant,
  parseToolsJson,
  permissionKey,
  type Tool,
} from "@tomat/shared";
import {
  type InstallEventSink,
  startInstall,
} from "../../toolkits/installer.ts";
import { toolkitsRegistry } from "../../toolkits/registry.ts";
import { workerPool } from "../../toolkits/workerPool.ts";
import { resolveVersion, searchPackages } from "../../toolkits/npmRegistry.ts";
import { embed } from "../../services/embedding.ts";
import { toolFilter } from "../../services/toolFilter.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";
import { wsHub } from "../../ws/hub.ts";

// Sink that broadcasts install_log + install_done frames to every paired
// client. The client's toolkits state subscribes to these and renders
// streamed progress in the install modal. install_done also triggers a
// `toolkit.snapshot` so the installed list refreshes without polling.
const BROADCAST_SINK: InstallEventSink = {
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

  r.post("/install", async (c) => {
    const body = (await readJson(c)) as
      | { source: "npm"; name: string; version?: string }
      | { source: "local"; path: string; slug?: string };
    if (body.source === "npm") {
      const result = startInstall(body, BROADCAST_SINK);
      return c.json(result);
    } else if (body.source === "local") {
      if (!body.slug) {
        throw new AppError("validation_error", "slug required for local");
      }
      const result = startInstall(
        { source: "local", path: body.path, slug: body.slug },
        BROADCAST_SINK,
      );
      return c.json(result);
    }
    throw new AppError("validation_error", "unknown source");
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const toolkit = toolkitsRegistry().getOrThrow(id);
    await workerPool().refreshPermissions(id);
    toolkitsRegistry().delete(id);
    try {
      await Deno.remove(toolkit.installedPath, { recursive: true });
    } catch { /* ignore */ }
    return c.body(null, 204);
  });

  r.post("/:id/update", async (c) => {
    const id = c.req.param("id");
    const toolkit = toolkitsRegistry().getOrThrow(id);
    const body = (await readJson(c)) as { version?: string };
    if (toolkit.source !== "npm") {
      throw new AppError(
        "validation_error",
        "only npm toolkits can be updated",
      );
    }
    const npmName = id.replace("__", "/");
    const resolved = await resolveVersion(npmName, body.version);
    const result = startInstall(
      { source: "npm", name: npmName, version: resolved.version },
      BROADCAST_SINK,
    );
    return c.json(result);
  });

  r.post("/:id/enable", (c) => {
    toolkitsRegistry().setEnabled(c.req.param("id"), true);
    return c.json({ id: c.req.param("id") });
  });

  r.post("/:id/disable", (c) => {
    toolkitsRegistry().setEnabled(c.req.param("id"), false);
    return c.json({ id: c.req.param("id") });
  });

  r.get("/:id/tools", async (c) => {
    const id = c.req.param("id");
    const tools = toolkitsRegistry().listTools(id);
    const enriched = await Promise.all(
      tools.map((t) => attachRequiredPermissions(t)),
    );
    return c.json({ tools: enriched });
  });

  r.post("/:id/tools/:tool/enable", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("tool");
    const tool = toolkitsRegistry().listTools(id).find((t) => t.name === name);
    if (!tool) throw new AppError("tool_not_found", `${id}::${name}`);
    const enriched = await attachRequiredPermissions(tool);
    if (enriched.missingRequired.length > 0) {
      throw new AppError(
        "permissions_required",
        `missing grants for ${name}`,
        {
          missing: enriched.missingRequired.map((i) =>
            enriched.requiredPermissions[i]
          ),
        },
      );
    }
    toolkitsRegistry().setToolEnabled(id, name, true);
    await workerPool().refreshPermissions(id);
    return c.json({ ok: true });
  });

  r.post("/:id/tools/:tool/disable", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("tool");
    toolkitsRegistry().setToolEnabled(id, name, false);
    await workerPool().refreshPermissions(id);
    return c.json({ ok: true });
  });

  r.post("/:id/tools/:tool/grants", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("tool");
    const tool = toolkitsRegistry().listTools(id).find((t) => t.name === name);
    if (!tool) throw new AppError("tool_not_found", `${id}::${name}`);
    const body = (await readJson(c)) as {
      grants: Array<{ key: string; state: Grant["state"] }>;
    };
    if (!Array.isArray(body.grants)) {
      throw new AppError("validation_error", "grants array required");
    }
    const enriched = await attachRequiredPermissions(tool);
    const decoded = body.grants.map((g) => {
      const decl = enriched.requiredPermissions.find((p) =>
        permissionKey(p) === g.key
      );
      if (!decl) {
        throw new AppError(
          "validation_error",
          `grant key ${g.key} not in this tool's required permissions`,
        );
      }
      return { key: g.key, kind: decl.kind, state: g.state };
    });
    const next = toolkitsRegistry().setGrants(tool.id, decoded);
    await workerPool().refreshPermissions(id);
    return c.json({ grants: next });
  });

  r.post("/reindex", async (c) => {
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

  r.post(
    "/tool-schemas",
    (c) =>
      c.req.json().then((body: { ids: string[] }) => {
        const tools = body.ids.map((id) => {
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
      }),
  );

  r.post("/embed", async (c) => {
    const body = (await readJson(c)) as { texts: string[] };
    if (!Array.isArray(body.texts)) {
      throw new AppError("validation_error", "texts array required");
    }
    const vectors = await embed(body.texts);
    return c.json({ vectors: vectors.map((v) => Array.from(v)) });
  });

  return r;
}

function allEnabledTools(): Array<{
  id: string;
  description: string;
  triggers: string[];
}> {
  // Cheap query straight to the tools table; toolFilter has a richer version.
  // Duplicated here to avoid importing toolFilter.ts internals.
  const list = toolkitsRegistry().list().filter((t) => t.enabled);
  const out: Array<{ id: string; description: string; triggers: string[] }> =
    [];
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
    const parsed = parseToolsJson(
      JSON.parse(await Deno.readTextFile(toolsJsonPath)),
    );
    if (!parsed.ok) throw new AppError("invalid_tools_json", parsed.message);
    const def = parsed.value.tools.find((t) => t.name === tool.name);
    if (!def) {
      return { ...tool, requiredPermissions: [], missingRequired: [] };
    }
    const required = flattenPermissions(def.permissions);
    const grantedKeys = new Set(
      tool.grants.filter((g) => g.state === "granted").map((g) =>
        g.permissionKey
      ),
    );
    const missing: number[] = [];
    for (let i = 0; i < required.length; i++) {
      if (required[i].optional) continue;
      if (!grantedKeys.has(permissionKey(required[i]))) missing.push(i);
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
