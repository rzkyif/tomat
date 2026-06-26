import { Hono } from "hono";
import type { Context } from "hono";
import {
  clientRevokeRequestSchema,
  errMessage,
  pairingCodeRequestSchema,
  pakeFinishRequestSchema,
  pakeStartRequestSchema,
} from "@tomat/shared";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { authService } from "../../services/auth.ts";
import { dropClientSettingsCache } from "../../services/core-settings.ts";
import { tlsCertFingerprint } from "../../services/tls.ts";
import { bearerMiddleware, requireClient } from "../middleware/auth.ts";
import { AppError } from "../middleware/errors.ts";
import { getLogger } from "../../shared/log.ts";
import { wsHub } from "../../ws/hub.ts";

const log = getLogger("http.pairing");

export function pairingRoutes(): Hono {
  const r = new Hono();

  // Mint a pairing code. Two authorization paths:
  //   A) X-Admin-Token  - device access (install script, "pair from this
  //      machine"). High-entropy; no rate limit needed.
  //   B) Bearer + password - an already-paired client minting remotely. The
  //      bearer proves the caller is a trusted device; the password is the
  //      second factor (argon2id + rate limited inside verifyAdminPassword).
  r.post("/codes", async (c) => {
    const body = await readJsonOrEmpty(c);
    const parsed = pairingCodeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("validation_error", parsed.error.message);
    }
    const adminToken = c.req.header("x-admin-token");
    if (adminToken) {
      await authService().verifyAdminToken(adminToken);
    } else {
      const client = await authService().authenticate(bearerToken(c));
      authService().verifyAdminPassword(parsed.data.password ?? null, peerIp(c), client.id);
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
    const result = authService().pakeStart(
      decodeBase64(parsed.data.sid),
      decodeBase64(parsed.data.msgA),
      parsed.data.clientName,
      peerIp(c),
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
    // A client may always remove ITSELF (the "leave" action). Revoking a
    // DIFFERENT paired device is a privileged fleet action: without this gate
    // any single paired device could wipe and lock out every other device. It
    // is authorized the same two ways as minting a code: the admin token
    // (device access) OR the admin password (an already-paired client, body).
    if (id !== me.id) {
      const adminToken = c.req.header("x-admin-token");
      if (adminToken) {
        await authService().verifyAdminToken(adminToken);
      } else {
        const body = await readJsonOrEmpty(c);
        const parsed = clientRevokeRequestSchema.safeParse(body);
        if (!parsed.success) {
          throw new AppError("validation_error", parsed.error.message);
        }
        authService().verifyAdminPassword(parsed.data.password ?? null, peerIp(c), me.id);
      }
    }
    const { existed, attachmentPaths } = authService().revokeClient(id);
    if (!existed) {
      throw new AppError("not_found", `no paired client with id ${id}`);
    }
    log.info(`client ${me.id} revoked client ${id}`);
    // Cut off any live WebSocket for the revoked client so revocation actually
    // removes access (the WS authenticates only once, at upgrade).
    wsHub().closeClient(id);
    // The client's per-client settings rows are cascade-deleted with its
    // `clients` row; drop the in-memory overlay cache to match.
    dropClientSettingsCache(id);
    // Best-effort cleanup of attachment files on disk. We've already
    // cascaded the DB rows so a stragglers-on-disk situation only wastes
    // bytes; log it but don't fail the request.
    for (const p of attachmentPaths) {
      try {
        await Deno.remove(p);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          log.warn(`revoke: failed to remove attachment ${p}: ${errMessage(err)}`);
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

// The bearer token from the Authorization header, or null. authService()
// .authenticate turns null into a 401, so callers can pass it straight through.
function bearerToken(c: Context): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  return match ? match[1].trim() : null;
}

// The REAL socket peer address, threaded from Deno.serve into the Hono env (see
// main.ts). We deliberately do NOT trust X-Forwarded-For / X-Real-IP, which are
// client-settable: an attacker would rotate them to hand every guess a fresh,
// empty rate-limit bucket. There is no reverse-proxy deployment mode today; add
// a trusted-proxy setting before honoring those headers.
function peerIp(c: Context): string {
  const peer = (c.env as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr;
  return peer?.hostname ?? "local";
}

async function readJsonOrEmpty(c: Context): Promise<unknown> {
  // No body OR a whitespace-only body reasonably means "use defaults" for
  // these endpoints (pairing/codes accepts an empty body for the default
  // TTL). A body present but malformed is a real client bug. We surface
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
