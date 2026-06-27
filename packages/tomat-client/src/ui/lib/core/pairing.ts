// Pairing client.
//
// Pairing is a CPace PAKE keyed by the 6-digit code. We first TOFU-capture the
// core's cert pin (the cert isn't pinned yet), then fold that pin into BOTH the
// CPace channel identifier (so the derived key itself is cert-bound) AND the key
// confirmation. A MITM that re-terminates TLS with a different cert is therefore
// detected twice over: the keys diverge, and `verifyConfirm` on core's
// `confirmS` fails, so we refuse to pair. On success we return the bearer token
// AND the pin to store, so every later connection enforces it.
//
// `PairingApi` (instance) covers operations on an ALREADY-paired core (mint a
// code for another client, list/revoke/rotate); those go through the pinned
// CoreClient. The free functions cover the UNPAIRED flow (probe, mint-with-
// admin-token, pair) where there is no pin yet.

import type {
  PairedClientEntry,
  PairingCodeRequest,
  PairingCodeResponse,
  PakeFinishResponse,
  PakeStartResponse,
} from "@tomat/shared";
import { confirmTag, cpaceInitiatorStart, randomSid, verifyConfirm } from "@tomat/shared";
import { type NetResponse, platform } from "../platform/index.ts";
import type { CoreClient } from "./client";

export interface PairResult {
  token: string;
  clientId: string;
  coreVersion: string;
  /** The cert pin captured at pairing; store it and pin all later connections. */
  tlsPin: string;
}

export class PairingApi {
  constructor(private readonly client: CoreClient) {}

  // Mint a code on this (already-paired) core. Requires the on-disk admin token.
  async mintCode(adminToken: string, req: PairingCodeRequest = {}): Promise<PairingCodeResponse> {
    const res = await platform().net.fetch({
      url: `${this.client.endpoint.baseUrl}/api/v1/pairing/codes`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": adminToken,
      },
      body: JSON.stringify(req),
      pin: this.client.endpoint.tlsPin,
    });
    if (!ok(res)) throw new Error(`mint pairing code: HTTP ${res.status}`);
    return JSON.parse(text(res)) as PairingCodeResponse;
  }

  // Mint a code on this (already-paired) core using the admin PASSWORD instead
  // of the on-disk token. The bearer (this.client) proves we're a paired
  // device; the password is the second factor. This is the remote path: it
  // needs no device access to the core's filesystem.
  mintCodeWithPassword(
    password: string,
    req: PairingCodeRequest = {},
  ): Promise<PairingCodeResponse> {
    return this.client.post("/api/v1/pairing/codes", { ...req, password });
  }

  listClients(): Promise<PairedClientEntry[]> {
    return this.client.get("/api/v1/pairing/clients");
  }

  // Revoke a client. Removing OURSELVES (the "leave" action) needs no password.
  // Removing ANOTHER device is privileged: pass the admin password, sent in the
  // request body over the pinned TLS channel.
  revoke(clientId: string, password?: string): Promise<void> {
    return this.client.del(
      `/api/v1/pairing/clients/${encodeURIComponent(clientId)}`,
      password ? { password } : undefined,
    ) as Promise<void>;
  }

  rotate(): Promise<{ token: string }> {
    return this.client.post("/api/v1/pairing/rotate", {});
  }
}

// --- unpaired flow (no pin yet) -------------------------------------------

/** Probe an unpaired core's health over a TOFU TLS connection. Returns the
 *  reported version and the captured cert pin (for optional display). */
export async function probeCore(baseUrl: string): Promise<{ version: string; pin: string }> {
  const res = await platform().net.fetch({
    url: `${baseUrl}/api/v1/health`,
    capturePin: true,
  });
  if (!ok(res)) throw new Error(`Core responded ${res.status}`);
  const body = JSON.parse(text(res)) as { version?: unknown };
  return {
    version: typeof body.version === "string" ? body.version : "unknown",
    pin: res.capturedPin ?? "",
  };
}

/** Set the admin password on a freshly-installed local core, authorized by its
 *  on-disk admin token, over TOFU TLS. Used by the client's "install on this
 *  computer" flow (the terminal installer prompts instead). The password lets
 *  this and other paired devices mint codes / revoke remotely afterward. */
export async function setAdminPasswordWithToken(
  baseUrl: string,
  adminToken: string,
  password: string,
): Promise<void> {
  const res = await platform().net.fetch({
    url: `${baseUrl}/api/v1/admin/password`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": adminToken,
    },
    body: JSON.stringify({ password }),
    capturePin: true,
  });
  if (!ok(res)) throw apiError(res, "set admin password");
}

/** Mint a code on an unpaired core via its admin token, over TOFU TLS. */
export async function mintCodeWithAdminToken(
  baseUrl: string,
  adminToken: string,
  req: PairingCodeRequest = {},
): Promise<PairingCodeResponse> {
  const res = await platform().net.fetch({
    url: `${baseUrl}/api/v1/pairing/codes`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": adminToken,
    },
    body: JSON.stringify(req),
    capturePin: true,
  });
  if (!ok(res)) throw new Error(`mint pairing code: HTTP ${res.status}`);
  return JSON.parse(text(res)) as PairingCodeResponse;
}

/** Run the full PAKE pairing against a core: TOFU-capture its cert, prove the
 *  code, channel-bind the pin, and verify core's confirmation (MITM-safe). */
export async function pairWithCode(
  baseUrl: string,
  clientName: string,
  code: string,
): Promise<PairResult> {
  // Step 0: capture the server's cert pin over a TOFU TLS connection (health is
  // unauthenticated). We do NOT trust it yet. It is folded into the CPace
  // channel identifier below AND the confirmation, and is only accepted once
  // core proves it knew the code AND presents this same cert.
  const probe = await platform().net.fetch({
    url: `${baseUrl}/api/v1/health`,
    capturePin: true,
  });
  const pin = probe.capturedPin;
  if (!pin) throw new Error("could not read the Core's TLS certificate");

  const sid = randomSid();
  const ci = new TextEncoder().encode(pin);
  const init = cpaceInitiatorStart(code, sid, ci);

  // Step 1: start, now enforcing the pin we observed.
  const startRes = await platform().net.fetch({
    url: `${baseUrl}/api/v1/pairing/pake/start`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName,
      sid: toBase64(sid),
      msgA: toBase64(init.msgA),
    }),
    pin,
  });
  if (!ok(startRes)) throw apiError(startRes, "pairing start failed");
  const start = JSON.parse(text(startRes)) as PakeStartResponse;
  const msgB = fromBase64(start.msgB);
  const isk = init.finish(msgB);

  // Step 2: finish. Our confirmation also binds the pin we observed.
  const confirmC = confirmTag(isk, "C", init.msgA, msgB, pin);
  const finishRes = await platform().net.fetch({
    url: `${baseUrl}/api/v1/pairing/pake/finish`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pakeId: start.pakeId,
      confirmC: toBase64(confirmC),
    }),
    pin,
  });
  if (!ok(finishRes)) throw apiError(finishRes, "pairing failed");
  const fin = JSON.parse(text(finishRes)) as PakeFinishResponse;

  // Authenticate core: its confirmation must verify against the pin we saw. A
  // MITM that terminated TLS with its own cert can't produce a matching tag.
  const serverOk = verifyConfirm(fromBase64(fin.confirmS), isk, "S", init.msgA, msgB, pin);
  if (!serverOk) {
    throw new Error(
      "Core authentication failed: the TLS certificate could not be verified " +
        "(possible man-in-the-middle). Not paired.",
    );
  }

  return {
    token: fin.token,
    clientId: fin.clientId,
    coreVersion: fin.coreVersion,
    tlsPin: pin,
  };
}

// --- helpers --------------------------------------------------------------

function ok(res: NetResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

function text(res: NetResponse): string {
  return new TextDecoder().decode(res.body);
}

function apiError(res: NetResponse, fallback: string): Error {
  try {
    const body = JSON.parse(text(res)) as { error?: { message?: string } };
    if (body.error?.message) return new Error(body.error.message);
  } catch {
    /* */
  }
  return new Error(`${fallback}: HTTP ${res.status}`);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
