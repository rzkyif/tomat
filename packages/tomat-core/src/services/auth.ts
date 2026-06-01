// Auth/pairing service.
//
// Pairing flow (PAKE, i.e. password-authenticated key exchange):
//   1. Operator (or client running on the host) calls POST /pairing/codes
//      with header X-Admin-Token = contents of ~/.tomat/core/.admin-token.
//      Core mints a 6-digit code with 10-min TTL and stores it (in the clear,
//      since the PAKE keys off the code value) in the pairing_codes table.
//   2. Client runs a CPace handshake keyed by the code over the TLS connection:
//      POST /pairing/pake/start { clientName, sid, msgA } then
//      POST /pairing/pake/finish { pakeId, confirmC }. The cert pin each side
//      observed is folded into BOTH the CPace channel identifier (so the derived
//      key is cert-bound) and the key confirmation, so a MITM that terminates TLS
//      with a different cert is detected (keys diverge + confirmation fails) even
//      if it relays the PAKE messages. On success core mints a 32-byte bearer token, stores
//      sha256(token) under a new clients row, claims the code, and returns the
//      token + its own confirmation (confirmS) so the client authenticates core.
//   3. Subsequent requests bearer-auth via sha256(token) lookup.
//
// Rate limits:
//   - Per code: 5 failed confirmations → poisoned (returns 410). A wrong code OR
//     a MITM-substituted cert both surface as a failed confirmation.
//   - Per IP: 20 start attempts per 10-minute sliding window → 429.

import { encodeBase64Url } from "jsr:@std/encoding@^1.0.0/base64url";
import { confirmTag, cpaceResponder, verifyConfirm } from "@tomat/shared";
import { CORE_VERSION } from "../config.ts";
import { db } from "../db/connection.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { newClientId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";
import { sha256Hex, toHex } from "../shared/hash.ts";
import type { PairedClientEntry, PairingCodeResponse } from "@tomat/shared";

const log = getLogger("auth");

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_CODE_TTL_MS = 60 * 60 * 1000; // 60 min ceiling
const MAX_ATTEMPTS_PER_CODE = 5;
const CLAIMS_PER_IP_WINDOW_MS = 10 * 60 * 1000;
const CLAIMS_PER_IP_MAX = 20;
const LAST_SEEN_DEBOUNCE_MS = 60_000;
// In-flight PAKE handshakes live only between start and finish (seconds).
const PAKE_SESSION_TTL_MS = 2 * 60 * 1000;
const MAX_PAKE_SESSIONS = 64;

export interface AuthedClient {
  id: string;
  name: string;
  createdAtMs: number;
  lastSeenMs: number;
}

export interface PakeStartResult {
  pakeId: string;
  msgB: Uint8Array;
}

export interface PakeFinishResult {
  token: string;
  clientId: string;
  coreVersion: string;
  confirmS: Uint8Array;
}

interface PakeSession {
  isk: Uint8Array;
  msgA: Uint8Array;
  msgB: Uint8Array;
  code: string; // the code this handshake was bound to
  clientName: string;
  expiresAtMs: number;
}

interface CodeRow {
  id: number;
  code: string;
  attempts: number;
  expires_at_ms: number;
}

class IpRateLimiter {
  private hits = new Map<string, number[]>();

  recordAndCheck(ip: string): boolean {
    const now = Date.now();
    const prior = this.hits.get(ip);
    // Build the next array in one pass: drop expired entries, count remaining,
    // append `now` if under the cap. The Map.set is the only mutation, so a
    // concurrent reader can never observe a half-updated slot. (V8 is
    // single-threaded today; this preserves the property if anyone ever
    // adds an `await` inside this function.)
    const next: number[] = [];
    if (prior) {
      for (const t of prior) {
        if (now - t < CLAIMS_PER_IP_WINDOW_MS) next.push(t);
      }
    }
    if (next.length >= CLAIMS_PER_IP_MAX) {
      this.hits.set(ip, next);
      return false;
    }
    next.push(now);
    this.hits.set(ip, next);
    return true;
  }
}

export class AuthService {
  private readonly ipLimiter = new IpRateLimiter();
  private readonly lastSeenWriteAt = new Map<string, number>();
  private readonly pakeSessions = new Map<string, PakeSession>();

  // --- pairing code mint ---------------------------------------------------

  async verifyAdminToken(provided: string | null): Promise<void> {
    if (!provided) {
      throw new AppError("admin_token_required", "missing X-Admin-Token");
    }
    const onDisk = await readAdminToken();
    if (!onDisk) {
      throw new AppError(
        "admin_token_required",
        "core has no admin token on disk; reinstall to mint one",
      );
    }
    if (!constantTimeEqual(provided, onDisk)) {
      throw new AppError("admin_token_required", "admin token mismatch");
    }
  }

  mintPairingCode(ttlSec?: number): PairingCodeResponse {
    const ttlMs = ttlSec ? Math.min(ttlSec * 1000, MAX_CODE_TTL_MS) : DEFAULT_CODE_TTL_MS;
    // Invalidate any previous outstanding code: only one active code per core.
    // Drop any in-flight handshakes bound to the old code too.
    db().prepare(`DELETE FROM pairing_codes WHERE claimed = 0`).run();
    this.pakeSessions.clear();
    const code = randomNumericCode();
    const now = Date.now();
    const expiresAtMs = now + ttlMs;
    db()
      .prepare(`
      INSERT INTO pairing_codes (code, created_at_ms, expires_at_ms, attempts, claimed)
      VALUES (?, ?, ?, 0, 0)
    `)
      .run(code, now, expiresAtMs);
    log.info(`minted pairing code, expires in ${Math.round(ttlMs / 1000)}s`);
    return { code, expiresAtMs };
  }

  // --- pairing PAKE handshake ----------------------------------------------

  // Step 1: run the CPace responder side against the active code and park the
  // session until finish. `msgA`/`sid` are raw bytes; `ip` is the socket peer
  // for the rate limiter; `serverPin` is our own cert pin, folded into the CPace
  // channel identifier so the derived key is cert-bound (a client that observed
  // a different cert derives a different key and confirmation fails). The
  // handshake does not reveal whether the client used the right code here. That
  // is decided by the confirmation at finish.
  pakeStart(
    sid: Uint8Array,
    msgA: Uint8Array,
    clientName: string,
    ip: string,
    serverPin: string,
  ): PakeStartResult {
    if (!this.ipLimiter.recordAndCheck(ip)) {
      throw new AppError("pairing_rate_limited", "too many pairing attempts from your IP");
    }
    const row = this.activeCodeRow();
    if (!row) {
      throw new AppError("invalid_pairing_code", "no active pairing code");
    }
    if (Date.now() > row.expires_at_ms) {
      throw new AppError("pairing_code_expired", "pairing code has expired");
    }
    let result;
    try {
      result = cpaceResponder(row.code, sid, msgA, new TextEncoder().encode(serverPin));
    } catch {
      // Malformed / identity msgA. Count it against the code like a bad guess.
      this.recordCodeFailure(row);
      throw new AppError("invalid_pairing_code", "invalid pairing message");
    }
    this.prunePakeSessions();
    const pakeId = randomPakeId();
    this.pakeSessions.set(pakeId, {
      isk: result.isk,
      msgA,
      msgB: result.msgB,
      code: row.code,
      clientName,
      expiresAtMs: Date.now() + PAKE_SESSION_TTL_MS,
    });
    return { pakeId, msgB: result.msgB };
  }

  // Step 2: verify the client's confirmation (which binds the pin it observed)
  // against OUR cert pin. A wrong code OR a MITM-substituted cert both make this
  // fail. On success mint a token, create the client, claim the code, and return
  // our own confirmation so the client can authenticate us + confirm the pin.
  async pakeFinish(
    pakeId: string,
    confirmC: Uint8Array,
    serverPin: string,
  ): Promise<PakeFinishResult> {
    const sess = this.pakeSessions.get(pakeId);
    if (!sess) {
      throw new AppError("invalid_pairing_code", "unknown or expired pairing handshake");
    }
    this.pakeSessions.delete(pakeId);
    if (Date.now() > sess.expiresAtMs) {
      throw new AppError("pairing_code_expired", "pairing handshake expired");
    }
    // The code this handshake bound must still be the active one (it could have
    // been claimed by another client, poisoned, or rotated in the meantime).
    const row = this.activeCodeRow();
    if (!row || row.code !== sess.code) {
      throw new AppError("pairing_code_claimed", "pairing code no longer active");
    }
    if (Date.now() > row.expires_at_ms) {
      throw new AppError("pairing_code_expired", "pairing code has expired");
    }

    const ok = verifyConfirm(confirmC, sess.isk, "C", sess.msgA, sess.msgB, serverPin);
    if (!ok) {
      // Wrong code or a MITM-substituted cert. Burn an attempt; poison after 5.
      this.recordCodeFailure(row);
      throw new AppError("invalid_pairing_code", "pairing confirmation failed");
    }

    // Confirmed: client knew the code AND observed our real cert. Mint + claim.
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const id = newClientId();
    const now = Date.now();
    db()
      .prepare(`
      INSERT INTO clients (id, name, token_hash, created_at_ms, last_seen_ms, revoked)
      VALUES (?, ?, ?, ?, ?, 0)
    `)
      .run(id, sess.clientName, tokenHash, now, now);
    db().prepare(`UPDATE pairing_codes SET claimed = 1 WHERE id = ?`).run(row.id);
    log.info(`paired new client "${sess.clientName}" (id=${id})`);
    const confirmS = confirmTag(sess.isk, "S", sess.msgA, sess.msgB, serverPin);
    return { token, clientId: id, coreVersion: CORE_VERSION, confirmS };
  }

  // The single active (unclaimed) pairing code row, if any.
  private activeCodeRow(): CodeRow | undefined {
    return db()
      .prepare(`
      SELECT id, code, attempts, expires_at_ms FROM pairing_codes WHERE claimed = 0
    `)
      .get() as CodeRow | undefined;
  }

  // Count a failed attempt against the active code; poison it after the cap so a
  // brute-force run over the 6-digit space is throttled to MAX_ATTEMPTS_PER_CODE.
  private recordCodeFailure(row: CodeRow): void {
    const nextAttempts = row.attempts + 1;
    db().prepare(`UPDATE pairing_codes SET attempts = ? WHERE id = ?`).run(nextAttempts, row.id);
    if (nextAttempts >= MAX_ATTEMPTS_PER_CODE) {
      db().prepare(`UPDATE pairing_codes SET claimed = 1 WHERE id = ?`).run(row.id);
      log.warn(`pairing code poisoned after ${nextAttempts} failed attempts`);
    }
  }

  // Drop expired in-flight handshakes (and the oldest if the map is oversized)
  // so a client that starts but never finishes can't pin memory.
  private prunePakeSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.pakeSessions) {
      if (now > s.expiresAtMs) this.pakeSessions.delete(id);
    }
    while (this.pakeSessions.size >= MAX_PAKE_SESSIONS) {
      const oldest = this.pakeSessions.keys().next().value;
      if (oldest === undefined) break;
      this.pakeSessions.delete(oldest);
    }
  }

  // --- bearer verification -------------------------------------------------

  async authenticate(bearer: string | null): Promise<AuthedClient> {
    if (!bearer) throw new AppError("missing_token", "missing bearer token");
    const tokenHash = await sha256Hex(bearer);
    const row = db()
      .prepare(`
      SELECT id, name, token_hash, created_at_ms, last_seen_ms, revoked
      FROM clients WHERE token_hash = ?
    `)
      .get(tokenHash) as
      | {
          id: string;
          name: string;
          token_hash: string;
          created_at_ms: number;
          last_seen_ms: number;
          revoked: number;
        }
      | undefined;
    if (!row) {
      throw new AppError("invalid_token", "bearer token not recognized");
    }
    if (row.revoked === 1) {
      throw new AppError("revoked", "this client has been revoked");
    }
    this.bumpLastSeen(row.id);
    return {
      id: row.id,
      name: row.name,
      createdAtMs: row.created_at_ms,
      lastSeenMs: row.last_seen_ms,
    };
  }

  // --- client list / revoke / rotate --------------------------------------

  listClients(callerId: string): PairedClientEntry[] {
    const rows = db()
      .prepare(`
      SELECT id, name, created_at_ms, last_seen_ms, revoked
      FROM clients
      ORDER BY created_at_ms DESC
    `)
      .all() as Array<{
      id: string;
      name: string;
      created_at_ms: number;
      last_seen_ms: number;
      revoked: number;
    }>;
    return rows
      .filter((r) => r.revoked === 0)
      .map((r) => ({
        id: r.id,
        name: r.name,
        createdAtMs: r.created_at_ms,
        lastSeenMs: r.last_seen_ms,
        isMe: r.id === callerId,
      }));
  }

  // Revokes the named client. Cascade-deletes sessions/messages/attachments
  // via foreign-key ON DELETE CASCADE in schema.sql. Returns the list of
  // attachment abs_paths so the caller can rm them off disk.
  revokeClient(clientId: string): { attachmentPaths: string[] } {
    const attachments = db()
      .prepare(`
      SELECT a.abs_path
      FROM attachments a
      JOIN sessions s ON s.id = a.session_id
      WHERE s.owner_client_id = ?
    `)
      .all(clientId) as Array<{ abs_path: string }>;
    db().prepare(`DELETE FROM clients WHERE id = ?`).run(clientId);
    return { attachmentPaths: attachments.map((a) => a.abs_path) };
  }

  async rotateToken(clientId: string): Promise<string> {
    const next = randomToken();
    const tokenHash = await sha256Hex(next);
    db().prepare(`UPDATE clients SET token_hash = ? WHERE id = ?`).run(tokenHash, clientId);
    return next;
  }

  // --- internals -----------------------------------------------------------

  // Update last_seen_ms at most once per minute per client (avoids hot-path
  // writes on every request).
  private bumpLastSeen(id: string): void {
    const now = Date.now();
    const last = this.lastSeenWriteAt.get(id) ?? 0;
    if (now - last < LAST_SEEN_DEBOUNCE_MS) return;
    this.lastSeenWriteAt.set(id, now);
    db().prepare(`UPDATE clients SET last_seen_ms = ? WHERE id = ?`).run(now, id);
  }
}

let _instance: AuthService | null = null;
export function authService(): AuthService {
  if (!_instance) _instance = new AuthService();
  return _instance;
}

// Test-only: drops the cached instance so the next `authService()` call
// rebuilds it. Use between tests when the underlying DB has been swapped.
export function __resetForTesting(): void {
  _instance = null;
}

// --- helpers ---------------------------------------------------------------

function randomNumericCode(): string {
  // 6 decimal digits, uniformly drawn over 0–999999. Padded to 6 chars.
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function randomPakeId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readAdminToken(): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(paths().adminTokenFile);
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
