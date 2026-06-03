import type { DeleteStoragePathsRequest, GetStorageResponse } from "@tomat/shared";
import type { CoreClient } from "./client";

/** Storage view (Settings → Usage → Storage): list downloaded models and
 *  reclaim disk by deleting them. The core owns the files; this is a thin
 *  wrapper over its /storage endpoints. */
export class StorageApi {
  constructor(private readonly client: CoreClient) {}

  /** The on-disk storage tree (downloaded models + sizes). */
  get(): Promise<GetStorageResponse> {
    return this.client.get<GetStorageResponse>("/api/v1/storage");
  }

  /** Delete the selected model files/folders (paths under the models dir). */
  deletePaths(paths: string[]): Promise<void> {
    const body: DeleteStoragePathsRequest = { paths };
    return this.client.post<void>("/api/v1/storage/delete", body);
  }

  /** Remove every downloaded model. */
  clearModels(): Promise<void> {
    return this.client.post<void>("/api/v1/storage/clear-models", {});
  }
}
