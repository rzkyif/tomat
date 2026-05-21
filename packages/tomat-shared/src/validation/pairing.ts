// Zod schemas for pairing-flow request bodies.

import { z } from "zod";

export const pairingCodeRequestSchema = z.object({
  // Optional caller-requested TTL in seconds. Core enforces a 60-min ceiling.
  ttlSec: z.number().int().min(60).max(60 * 60).optional(),
}).strict();

export type PairingCodeRequest = z.infer<typeof pairingCodeRequestSchema>;

export const pairingClaimRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, {
    message: "code must be 6 decimal digits",
  }),
  clientName: z.string().min(1).max(64),
}).strict();

export type PairingClaimRequest = z.infer<typeof pairingClaimRequestSchema>;

export interface PairingCodeResponse {
  code: string;
  expiresAtMs: number;
}

export interface PairingClaimResponse {
  token: string;
  clientId: string;
  coreVersion: string;
}

export interface PairedClientEntry {
  id: string;
  name: string;
  createdAtMs: number;
  lastSeenMs: number;
  isMe: boolean;
}
