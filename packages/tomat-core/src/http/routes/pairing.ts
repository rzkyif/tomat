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
import { getLogger } from "../../shared/log.ts";

const log = getLogger("http.pairing");

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
    // Best-effort cleanup of attachment files on disk. We've already
    // cascaded the DB rows so a stragglers-on-disk situation only wastes
    // bytes; log it but don't fail the request.
    for (const p of attachmentPaths) {
      try {
        await Deno.remove(p);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          log.warn(
            `revoke: failed to remove attachment ${p}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }
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
  // No body OR a whitespace-only body reasonably means "use defaults" for
  // these endpoints (pairing/codes accepts an empty body for the default
  // TTL). A body present but malformed is a real client bug — we surface
  // it as HTTP 400 instead of silently treating it as `{}`. Content-Length
  // is unreliable across runtimes (Request from `new Request(..., { body: '' })`
  // may omit it), so peek at the text instead.
  const text = await c.req.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
