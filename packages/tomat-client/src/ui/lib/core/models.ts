import type {
  DownloadModelsRequest,
  DownloadModelsResponse,
  ListDownloadsResponse,
  ListModelsResponse,
  ProbeModelsResponse,
} from "@tomat/shared";
import type { CoreClient } from "./client";

export class ModelsApi {
  constructor(private readonly client: CoreClient) {}

  list(): Promise<ListModelsResponse> {
    return this.client.get("/api/v1/models");
  }

  download(req: DownloadModelsRequest): Promise<DownloadModelsResponse> {
    return this.client.post("/api/v1/models/download", req);
  }

  delete(relPath: string): Promise<void> {
    return this.client.del(`/api/v1/models/${encodeURI(relPath)}`) as Promise<void>;
  }

  downloads(): Promise<ListDownloadsResponse> {
    return this.client.get("/api/v1/models/downloads");
  }

  cancel(id: string): Promise<void> {
    return this.client.post(`/api/v1/models/downloads/${encodeURIComponent(id)}/cancel`, {});
  }

  retry(id: string): Promise<void> {
    return this.client.post(`/api/v1/models/downloads/${encodeURIComponent(id)}/retry`, {});
  }

  remove(id: string): Promise<void> {
    return this.client.del(`/api/v1/models/downloads/${encodeURIComponent(id)}`) as Promise<void>;
  }

  probe(sources: string[]): Promise<ProbeModelsResponse> {
    return this.client.post("/api/v1/models/probe", { sources });
  }
}
