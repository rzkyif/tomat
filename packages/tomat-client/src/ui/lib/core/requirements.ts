import type { DownloadRequirementsResponse, GetRequirementsResponse } from "@tomat/shared";
import type { CoreClient } from "./client";

export class RequirementsApi {
  constructor(private readonly client: CoreClient) {}

  /** The full required-files list + the missing subset for the current config. */
  get(): Promise<GetRequirementsResponse> {
    return this.client.get("/api/v1/requirements");
  }

  /** Download everything currently missing (models + binaries). */
  download(): Promise<DownloadRequirementsResponse> {
    return this.client.post("/api/v1/requirements/download", {});
  }
}
