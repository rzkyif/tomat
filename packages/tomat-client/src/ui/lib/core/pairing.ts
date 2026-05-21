// Pairing wrappers. The /codes endpoint requires the admin token (only the
// host can mint codes); /claim is unauth'd. Use a transient CoreClient with
// an empty token for the claim, then rebuild with the returned bearer.

import type {
  PairedClientEntry,
  PairingClaimRequest,
  PairingClaimResponse,
  PairingCodeRequest,
  PairingCodeResponse,
} from "@tomat/shared";
import type { CoreClient } from "./client";

export class PairingApi {
  constructor(private readonly client: CoreClient) {}

  // Requires X-Admin-Token header. Pass the on-disk admin token from
  // platform.readAdminToken(). Returns the freshly-minted pairing code.
  async mintCode(adminToken: string, req: PairingCodeRequest = {}): Promise<PairingCodeResponse> {
    const res = await fetch(`${this.client.endpoint.baseUrl}/api/v1/pairing/codes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": adminToken,
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`mint pairing code: HTTP ${res.status}`);
    return (await res.json()) as PairingCodeResponse;
  }

  // Unauthenticated. Use a transient client with an empty token.
  static async claim(baseUrl: string, req: PairingClaimRequest): Promise<PairingClaimResponse> {
    const res = await fetch(`${baseUrl}/api/v1/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`pairing claim: HTTP ${res.status}`);
    return (await res.json()) as PairingClaimResponse;
  }

  listClients(): Promise<PairedClientEntry[]> {
    return this.client.get("/api/v1/pairing/clients");
  }

  revoke(clientId: string): Promise<void> {
    return this.client.del(
      `/api/v1/pairing/clients/${encodeURIComponent(clientId)}`,
    ) as Promise<void>;
  }

  rotate(): Promise<{ token: string }> {
    return this.client.post("/api/v1/pairing/rotate", {});
  }
}
