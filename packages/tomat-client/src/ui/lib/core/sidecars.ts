import type { SidecarsStatusResponse } from "@tomat/shared";
import type { CoreClient } from "./client";

/** Sidecar status + live resource usage (Settings → Usage → Services). The
 *  core samples its own process + sidecar PIDs on each request; this is a thin
 *  wrapper polled while the Services field is visible. */
export class SidecarsApi {
  constructor(private readonly client: CoreClient) {}

  /** Sidecar snapshots (with rssMb/cpuPct) + the core process metrics. */
  status(): Promise<SidecarsStatusResponse> {
    return this.client.get<SidecarsStatusResponse>("/api/v1/sidecars/status");
  }
}
