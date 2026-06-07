import type {
  AppliedModelSettings,
  CatalogModelView,
  DownloadModelsRequest,
  DownloadModelsResponse,
  ListDownloadsResponse,
  ListModelsResponse,
  PresetBucket,
  ProbeModelsResponse,
  RecommendationSet,
} from "@tomat/shared";
import type { CoreClient } from "./client";

export interface CatalogResponse {
  generatedAt: string;
  models: CatalogModelView[];
}

export interface SelectModelResponse {
  applied: { preset: string; settings: AppliedModelSettings };
}

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

  // --- adaptive presets + model browser ----------------------------------

  /** The three computed presets for this device + what's currently applied. */
  recommend(): Promise<RecommendationSet> {
    return this.client.get("/api/v1/models/recommend");
  }

  /** Force-refresh the catalog + re-probe hardware, then recompute. */
  recheck(): Promise<RecommendationSet> {
    return this.client.post("/api/v1/models/recommend/recheck", {});
  }

  /** Full model list annotated with fit-on-this-device (the browser). */
  catalog(): Promise<CatalogResponse> {
    return this.client.get("/api/v1/models/catalog");
  }

  /** Apply a preset bucket, a catalog model (its recommended quant), or a
   *  specific quant by its modelSpec: writes llm.* settings. */
  select(
    sel: { bucket: PresetBucket } | { modelId: string } | { modelSpec: string },
  ): Promise<SelectModelResponse> {
    return this.client.post("/api/v1/models/select", sel);
  }
}
