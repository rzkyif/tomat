import { Hono } from "hono";
import {
  errMessage,
  pairingCodeRequestSchema,
  pakeFinishRequestSchema,
  pakeStartRequestSchema,
} from "@tomat/shared";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";
import { authService } from "../../services/auth.ts";
import { tlsCertFingerprint } from "../../services/tls.ts";
import {
  adminTokenMiddleware,
  bearerMiddleware,
  requireClient,
} from "../middleware/auth.ts";
import { AppError } from "../middleware/errors.ts";
import { getLogger } from "../../shared/log.ts";
import { wsHub } from "../../ws/hub.ts";

const log = getLogger("http.pairing");

export function pairingRoutes(): Hono {
  const r = new Hono();

  r.post("/codes", adminTokenMiddleware(), async (c) => {
    const body = await readJsonOrEmpty(c);
    const parsed = pairingCodeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const result = authService().mintPairingCode(parsed.data.ttlSec);
    return c.json(result);
  });

  // PAKE step 1: the client runs the CPace initiator keyed by the pairing code
  // and sends its session id + first message. Core responds with its message.
  r.post("/pake/start", async (c) => {
    const body = await readJsonOrEmpty(c);
    const parsed = pakeStartRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    // Rate-limit key: the REAL socket peer address, threaded from Deno.serve
    // into the Hono env (see main.ts). We deliberately do NOT trust
    // X-Forwarded-For / X-Real-IP — those are client-settable, so an attacker
    // would rotate them to hand every guess a fresh, empty rate-limit bucket
    // and brute-force the pairing code. There is no reverse-proxy deployment
    // mode today; add a trusted-proxy setting before honoring those headers.
    const peer = (c.env as { remoteAddr?: { hostname?: string } } | undefined)
      ?.remoteAddr;
    const ip = peer?.hostname ?? "local";
    const result = authService().pakeStart(
      decodeBase64(parsed.data.sid),
      decodeBase64(parsed.data.msgA),
      parsed.data.clientName,
      ip,
      await tlsCertFingerprint(),
    );
    return c.json({ pakeId: result.pakeId, msgB: encodeBase64(result.msgB) });
  });

  // PAKE step 2: the client confirms (its confirmation binds the cert pin it
  // observed). Core verifies it against its OWN pin; a wrong code or a MITM cert
  // both fail. On success core mints the token and returns its own confirmation.
  r.post("/pake/finish", async (c) => {
    const body = await readJsonOrEmpty(c);
    const parsed = pakeFinishRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const result = await authService().pakeFinish(
      parsed.data.pakeId,
      decodeBase64(parsed.data.confirmC),
      await tlsCertFingerprint(),
    );
    return c.json({
      token: result.token,
      clientId: result.clientId,
      coreVersion: result.coreVersion,
      confirmS: encodeBase64(result.confirmS),
    });
  });

  r.get("/clients", bearerMiddleware(), (c) => {
    const me = requireClient(c);
    return c.json(authService().listClients(me.id));
  });

  r.delete("/clients/:id", bearerMiddleware(), async (c) => {
    const me = requireClient(c);
    const id = c.req.param("id") === "me" ? me.id : c.req.param("id");
    const { attachmentPaths } = authService().revokeClient(id);
    // Cut off any live WebSocket for the revoked client so revocation actually
    // removes access (the WS authenticates only once, at upgrade).
    wsHub().closeClient(id);
    // Best-effort cleanup of attachment files on disk. We've already
    // cascaded the DB rows so a stragglers-on-disk situation only wastes
    // bytes; log it but don't fail the request.
    for (const p of attachmentPaths) {
      try {
        await Deno.remove(p);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          log.warn(
            `revoke: failed to remove attachment ${p}: ${errMessage(err)}`,
          );
        }
      }
    }
    return c.body(null, 204);
  });

  r.post("/rotate", bearerMiddleware(), async (c) => {
    const me = requireClient(c);
    const token = await authService().rotateToken(me.id);
    // Drop existing sockets: they were authenticated with the OLD token, which
    // is now invalid. The client reconnects /ws/v1 with the new token.
    wsHub().closeClient(me.id);
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
