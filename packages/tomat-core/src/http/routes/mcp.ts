// MCP server management: CRUD for configured servers, per-tool / per-prompt
// enablement, and the live prompt/resource listings the client's "/" and "@"
// autocomplete consume. Connecting/disconnecting is reconciled by the manager
// after any change that affects which servers are enabled.

import { Hono } from "hono";
import { z } from "zod";
import { mcpRegistry } from "../../mcp/registry.ts";
import { mcpAuthSecretName } from "../../mcp/secret-key.ts";
import { mcpManager } from "../../mcp/manager.ts";
import { deleteSecret, setSecret } from "../../services/secrets.ts";
import { wsHub } from "../../ws/hub.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

const serverBody = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["stdio", "remote"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    runtime: z.enum(["custom", "deno"]).optional(),
    denoAllowAll: z.boolean().optional(),
    denoPermissions: z.array(z.string()).optional(),
    url: z.string().optional(),
    enabled: z.boolean().optional(),
    // Remote bearer token: write-only. Omitted = leave as-is; "" = clear; a
    // value = store in the vault. Never echoed back (the projection only
    // exposes `hasAuth`).
    authToken: z.string().optional(),
  })
  .strict();

/** Persist a server's bearer token to the vault. Returns the hasAuth flag to
 *  store on the row. `undefined` token leaves the existing secret untouched. */
async function applyAuthToken(id: string, token: string | undefined): Promise<boolean | undefined> {
  if (token === undefined) return undefined;
  if (token === "") {
    await deleteSecret(mcpAuthSecretName(id));
    return false;
  }
  await setSecret(mcpAuthSecretName(id), token);
  return true;
}

/** Reconnect/disconnect to match the current enabled set, then repaint. */
async function resync(): Promise<void> {
  await mcpManager().sync(mcpRegistry().list());
  wsHub().broadcastAll({ kind: "mcp.snapshot" });
}

export function mcpRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", (c) => c.json({ servers: mcpRegistry().list() }));
  r.get("/prompts", (c) => c.json({ prompts: mcpRegistry().listPrompts() }));
  r.get("/resources", (c) => c.json({ resources: mcpRegistry().listResources() }));

  r.post("/", async (c) => {
    const parsed = serverBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const { authToken, ...input } = parsed.data;
    const server = mcpRegistry().create(input);
    const hasAuth = await applyAuthToken(server.id, authToken);
    if (hasAuth !== undefined) {
      mcpRegistry().update(server.id, { hasAuth });
    }
    await resync();
    return c.json(mcpRegistry().getOrThrow(server.id), 201);
  });

  r.get("/:id", (c) => c.json(mcpRegistry().getOrThrow(c.req.param("id"))));

  r.patch("/:id", async (c) => {
    const parsed = serverBody.partial().safeParse(await readJson(c));
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const id = c.req.param("id");
    const { authToken, ...data } = parsed.data;
    const hasAuth = await applyAuthToken(id, authToken);
    mcpRegistry().update(id, { ...data, hasAuth });
    // A change to connection config (transport, command/args, url, auth) must
    // drop the live session so resync reconnects with the new settings; a rename
    // alone (no connection fields) leaves the connection untouched.
    if (
      data.kind !== undefined ||
      data.command !== undefined ||
      data.args !== undefined ||
      data.runtime !== undefined ||
      data.denoAllowAll !== undefined ||
      data.denoPermissions !== undefined ||
      data.url !== undefined ||
      hasAuth !== undefined
    ) {
      await mcpManager().disconnect(id);
    }
    await resync();
    return c.json(mcpRegistry().getOrThrow(id));
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    mcpRegistry().delete(id);
    await deleteSecret(mcpAuthSecretName(id)).catch(() => {});
    await resync();
    return c.json({ ok: true });
  });

  // Force a reconnect attempt (e.g. after fixing a misconfigured server).
  r.post("/:id/reconnect", async (c) => {
    await mcpManager().disconnect(c.req.param("id"));
    await resync();
    return c.json(mcpRegistry().getOrThrow(c.req.param("id")));
  });

  r.post("/:id/tools/:tool/:action", (c) => {
    const action = c.req.param("action");
    const enabled = action === "enable";
    if (!enabled && action !== "disable") {
      throw new AppError("validation_error", "bad action");
    }
    const server = mcpRegistry().setToolEnabled(c.req.param("id"), c.req.param("tool"), enabled);
    wsHub().broadcastAll({ kind: "mcp.snapshot" });
    return c.json(server);
  });

  r.post("/:id/prompts/:prompt/:action", (c) => {
    const action = c.req.param("action");
    const enabled = action === "enable";
    if (!enabled && action !== "disable") {
      throw new AppError("validation_error", "bad action");
    }
    const server = mcpRegistry().setPromptEnabled(
      c.req.param("id"),
      c.req.param("prompt"),
      enabled,
    );
    wsHub().broadcastAll({ kind: "mcp.snapshot" });
    return c.json(server);
  });

  return r;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
