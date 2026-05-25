// Auth/pairing service.
//
// Pairing flow:
//   1. Operator (or client running on the host) calls POST /pairing/codes
//      with header X-Admin-Token = contents of ~/.tomat/core/.admin-token.
//      Core mints a 6-digit code with 10-min TTL and stores sha256(code)
//      in the pairing_codes table.
//   2. Client calls POST /pairing/claim with { code, clientName }.
//      Core hashes the code, looks it up, checks attempts < 5 and not expired,
//      mints a 32-byte bearer token, stores sha256(token) under a new
//      clients row, marks the code claimed, returns the token.
//   3. Subsequent requests bearer-auth via sha256(token) lookup.
//
// Rate limits:
//   - Per code: 5 attempts → poisoned (status="claimed", returns 410).
//   - Per IP: 20 claim attempts per 10-minute sliding window → 429.

import { encodeBase64Url } from "jsr:@std/encoding@^1.0.0/base64url";
import { CORE_VERSION } from "../config.ts";
import { db } from "../db/connection.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { newClientId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";
import type {
  PairedClientEntry,
  PairingClaimResponse,
  PairingCodeResponse,
} from "@tomat/shared";

const log = getLogger("auth");

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_CODE_TTL_MS = 60 * 60 * 1000; // 60 min ceiling
const MAX_ATTEMPTS_PER_CODE = 5;
const CLAIMS_PER_IP_WINDOW_MS = 10 * 60 * 1000;
const CLAIMS_PER_IP_MAX = 20;
const LAST_SEEN_DEBOUNCE_MS = 60_000;

export interface AuthedClient {
  id: string;
  name: string;
  createdAtMs: number;
  lastSeenMs: number;
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

  async mintPairingCode(ttlSec?: number): Promise<PairingCodeResponse> {
    const ttlMs = ttlSec
      ? Math.min(ttlSec * 1000, MAX_CODE_TTL_MS)
      : DEFAULT_CODE_TTL_MS;
    // Invalidate any previous outstanding code: only one active code per core.
    db().prepare(`DELETE FROM pairing_codes WHERE claimed = 0`).run();
    const code = randomNumericCode();
    const codeHash = await sha256Hex(code);
    const now = Date.now();
    const expiresAtMs = now + ttlMs;
    db().prepare(`
      INSERT INTO pairing_codes (code_hash, created_at_ms, expires_at_ms, attempts, claimed)
      VALUES (?, ?, ?, 0, 0)
    `).run(codeHash, now, expiresAtMs);
    log.info(`minted pairing code, expires in ${Math.round(ttlMs / 1000)}s`);
    return { code, expiresAtMs };
  }

  // --- pairing claim -------------------------------------------------------

  async claim(
    code: string,
    clientName: string,
    ip: string,
  ): Promise<PairingClaimResponse> {
    if (!this.ipLimiter.recordAndCheck(ip)) {
      throw new AppError(
        "pairing_rate_limited",
        "too many pairing attempts from your IP",
      );
    }
    const codeHash = await sha256Hex(code);
    const row = db().prepare(`
      SELECT code_hash, expires_at_ms, attempts, claimed FROM pairing_codes WHERE code_hash = ?
    `).get(codeHash) as
      | {
        code_hash: string;
        expires_at_ms: number;
        attempts: number;
        claimed: number;
      }
      | undefined;
    if (!row) {
      throw new AppError("invalid_pairing_code", "no such pairing code");
    }
    if (row.claimed === 1) {
      throw new AppError("pairing_code_claimed", "pairing code already used");
    }
    if (Date.now() > row.expires_at_ms) {
      throw new AppError("pairing_code_expired", "pairing code has expired");
    }

    // Increment attempt counter before checking — if this attempt fails, the
    // count is still bumped.
    const nextAttempts = row.attempts + 1;
    db().prepare(`UPDATE pairing_codes SET attempts = ? WHERE code_hash = ?`)
      .run(
        nextAttempts,
        codeHash,
      );
    if (nextAttempts >= MAX_ATTEMPTS_PER_CODE) {
      db().prepare(`UPDATE pairing_codes SET claimed = 1 WHERE code_hash = ?`)
        .run(codeHash);
      throw new AppError(
        "invalid_pairing_code",
        "pairing code poisoned after too many attempts",
      );
    }

    // Success: mint a token, create a client row, mark code claimed.
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const id = newClientId();
    const now = Date.now();
    db().prepare(`
      INSERT INTO clients (id, name, token_hash, created_at_ms, last_seen_ms, revoked)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(id, clientName, tokenHash, now, now);
    db().prepare(`UPDATE pairing_codes SET claimed = 1 WHERE code_hash = ?`)
      .run(codeHash);
    log.info(`paired new client "${clientName}" (id=${id})`);
    return { token, clientId: id, coreVersion: CORE_VERSION };
  }

  // --- bearer verification -------------------------------------------------

  async authenticate(bearer: string | null): Promise<AuthedClient> {
    if (!bearer) throw new AppError("missing_token", "missing bearer token");
    const tokenHash = await sha256Hex(bearer);
    const row = db().prepare(`
      SELECT id, name, token_hash, created_at_ms, last_seen_ms, revoked
      FROM clients WHERE token_hash = ?
    `).get(tokenHash) as
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
    const rows = db().prepare(`
      SELECT id, name, created_at_ms, last_seen_ms, revoked
      FROM clients
      ORDER BY created_at_ms DESC
    `).all() as Array<{
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
    const attachments = db().prepare(`
      SELECT a.abs_path
      FROM attachments a
      JOIN sessions s ON s.id = a.session_id
      WHERE s.owner_client_id = ?
    `).all(clientId) as Array<{ abs_path: string }>;
    db().prepare(`DELETE FROM clients WHERE id = ?`).run(clientId);
    return { attachmentPaths: attachments.map((a) => a.abs_path) };
  }

  async rotateToken(clientId: string): Promise<string> {
    const next = randomToken();
    const tokenHash = await sha256Hex(next);
    db().prepare(`UPDATE clients SET token_hash = ? WHERE id = ?`).run(
      tokenHash,
      clientId,
    );
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
    db().prepare(`UPDATE clients SET last_seen_ms = ? WHERE id = ?`).run(
      now,
      id,
    );
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
  const n = (buf[0] << 24 | buf[1] << 16 | buf[2] << 8 | buf[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
