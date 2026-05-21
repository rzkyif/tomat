import { Hono } from "hono";
import {
  pairingClaimRequestSchema,
  pairingCodeRequestSchema,
} from "@tomat/shared";
import { authService } from "../../services/auth.ts";
import {
  adminTokenMiddleware,
  bearerMiddleware,
  requireClient,
} from "../middleware/auth.ts";
import { AppError } from "../middleware/errors.ts";

export function pairingRoutes(): Hono {
  const r = new Hono();

  r.post("/codes", adminTokenMiddleware(), async (c) => {
    const body = await readJsonOrEmpty(c);
    const parsed = pairingCodeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const result = await authService().mintPairingCode(parsed.data.ttlSec);
    return c.json(result);
  });

  r.post("/claim", async (c) => {
    const body = await readJsonOrEmpty(c);
    const parsed = pairingClaimRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ??
      "local";
    const result = await authService().claim(
      parsed.data.code,
      parsed.data.clientName,
      ip,
    );
    return c.json(result);
  });

  r.get("/clients", bearerMiddleware(), (c) => {
    const me = requireClient(c);
    return c.json(authService().listClients(me.id));
  });

  r.delete("/clients/:id", bearerMiddleware(), async (c) => {
    const me = requireClient(c);
    const id = c.req.param("id") === "me" ? me.id : c.req.param("id");
    const { attachmentPaths } = authService().revokeClient(id);
    // Best-effort cleanup of attachment files on disk.
    for (const p of attachmentPaths) {
      try {
        await Deno.remove(p);
      } catch { /* ignore */ }
    }
    return c.body(null, 204);
  });

  r.post("/rotate", bearerMiddleware(), async (c) => {
    const me = requireClient(c);
    const token = await authService().rotateToken(me.id);
    return c.json({ token });
  });

  return r;
}

async function readJsonOrEmpty(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
