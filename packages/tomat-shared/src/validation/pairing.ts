// Zod schemas for pairing-flow request bodies.
//
// Pairing is a PAKE (password-authenticated key exchange) handshake keyed by the
// 6-digit code, run over the capture-mode TLS connection. It replaces the old
// single unauthenticated `POST /pairing/claim`. The key confirmation folds in the
// TLS cert pin each side observes, so a man-in-the-middle that terminates TLS with
// a different cert is detected even though it relays the PAKE messages. See
// `@tomat/shared/crypto/pake` for the primitive and AGENTS.md for the flow.

import { z } from "zod";

// Base64 of an N-byte buffer (no padding tolerance needed — both ends use btoa).
const base64 = (label: string) =>
  z.string().min(1).max(512).regex(/^[A-Za-z0-9+/]+=*$/, {
    message: `${label} must be base64`,
  });

const clientName = z.string().min(1).max(64);

export const pairingCodeRequestSchema = z.object({
  // Optional caller-requested TTL in seconds. Core enforces a 60-min ceiling.
  ttlSec: z.number().int().min(60).max(60 * 60).optional(),
}).strict();

export type PairingCodeRequest = z.infer<typeof pairingCodeRequestSchema>;

export interface PairingCodeResponse {
  code: string;
  expiresAtMs: number;
}

// --- PAKE handshake -------------------------------------------------------

// Step 1: client (initiator) → core. `sid` is the CPace session id the client
// generated; `msgA` is the client's CPace public element (Ya).
export const pakeStartRequestSchema = z.object({
  clientName,
  sid: base64("sid"),
  msgA: base64("msgA"),
}).strict();

export type PakeStartRequest = z.infer<typeof pakeStartRequestSchema>;

export interface PakeStartResponse {
  // Opaque handle for the in-flight handshake; echoed back in the finish call.
  pakeId: string;
  // Core's CPace public element (Yb).
  msgB: string;
}

// Step 2: client → core. `confirmC` is MAC(K, "C" ‖ transcript ‖ pinClientSaw).
export const pakeFinishRequestSchema = z.object({
  pakeId: z.string().min(1).max(64),
  confirmC: base64("confirmC"),
}).strict();

export type PakeFinishRequest = z.infer<typeof pakeFinishRequestSchema>;

export interface PakeFinishResponse {
  token: string;
  clientId: string;
  coreVersion: string;
  // MAC(K, "S" ‖ transcript ‖ pinCoreHas) — the client verifies it against the
  // pin it observed, authenticating core and confirming the pin (no MITM).
  confirmS: string;
}

export interface PairedClientEntry {
  id: string;
  name: string;
  createdAtMs: number;
  lastSeenMs: number;
  isMe: boolean;
}
