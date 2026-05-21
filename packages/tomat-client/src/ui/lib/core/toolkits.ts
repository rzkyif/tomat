import type {
  EmbedRequest,
  EmbedResponse,
  Grant,
  InstallToolkitRequest,
  InstallToolkitResponse,
  ListToolkitsResponse,
  ListToolkitToolsResponse,
  SearchToolkitsResponse,
  SetGrantsResponse,
  ToolFilterRequest,
  ToolFilterResponse,
  ToolSchemasResponse,
  UpdateToolkitResponse,
} from "@tomat/shared";
import type { CoreClient } from "./client";

export class ToolkitsApi {
  constructor(private readonly client: CoreClient) {}

  list(): Promise<ListToolkitsResponse> {
    return this.client.get("/api/v1/toolkits");
  }

  search(
    q: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<SearchToolkitsResponse> {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    return this.client.get(`/api/v1/toolkits/search?${params}`);
  }

  install(req: InstallToolkitRequest): Promise<InstallToolkitResponse> {
    return this.client.post("/api/v1/toolkits/install", req);
  }

  delete(id: string): Promise<void> {
    return this.client.del(`/api/v1/toolkits/${encodeURIComponent(id)}`) as Promise<void>;
  }

  update(id: string, version?: string): Promise<UpdateToolkitResponse> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/update`, { version });
  }

  enable(id: string): Promise<void> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/enable`, {});
  }

  disable(id: string): Promise<void> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/disable`, {});
  }

  listTools(id: string): Promise<ListToolkitToolsResponse> {
    return this.client.get(`/api/v1/toolkits/${encodeURIComponent(id)}/tools`);
  }

  enableTool(id: string, tool: string): Promise<{ ok: boolean }> {
    return this.client.post(
      `/api/v1/toolkits/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/enable`,
      {},
    );
  }

  disableTool(id: string, tool: string): Promise<{ ok: boolean }> {
    return this.client.post(
      `/api/v1/toolkits/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/disable`,
      {},
    );
  }

  setGrants(
    id: string,
    tool: string,
    grants: Array<{ key: string; state: Grant["state"] }>,
  ): Promise<SetGrantsResponse> {
    return this.client.post(
      `/api/v1/toolkits/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/grants`,
      { grants },
    );
  }

  reindex(): Promise<{ embedded: number }> {
    return this.client.post("/api/v1/toolkits/reindex", {});
  }

  filter(req: ToolFilterRequest): Promise<ToolFilterResponse> {
    return this.client.post("/api/v1/toolkits/filter", req);
  }

  toolSchemas(ids: string[]): Promise<ToolSchemasResponse> {
    return this.client.post("/api/v1/toolkits/tool-schemas", { ids });
  }

  embed(req: EmbedRequest): Promise<EmbedResponse> {
    return this.client.post("/api/v1/toolkits/embed", req);
  }
}
