import type {
  CheckUpdatesResponse,
  DownloadToolkitRequest,
  EmbedRequest,
  EmbedResponse,
  Grant,
  ListToolkitsResponse,
  ListToolkitToolsResponse,
  SearchToolkitsResponse,
  SetGrantsResponse,
  ToolFilterRequest,
  ToolFilterResponse,
  Toolkit,
  ToolkitActionResponse,
  ToolkitJobResponse,
  ToolSchemasResponse,
  UndeclaredPolicy,
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

  // Phase 1: acquire a toolkit's files (npm/local/builtin). Returns a streamed
  // job; deps are installed separately via installDeps.
  download(req: DownloadToolkitRequest): Promise<ToolkitJobResponse> {
    return this.client.post("/api/v1/toolkits/download", req);
  }

  // Phase 2: install a downloaded toolkit's dependencies + pin its hash.
  installDeps(id: string): Promise<ToolkitJobResponse> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/install`, {});
  }

  delete(id: string): Promise<void> {
    return this.client.del(`/api/v1/toolkits/${encodeURIComponent(id)}`) as Promise<void>;
  }

  // Revert an installed, deps-bearing toolkit to 'downloaded' (drop its installed
  // deps). The source files stay so it can be re-installed.
  uninstall(id: string): Promise<ToolkitActionResponse> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/uninstall`, {});
  }

  update(id: string, version?: string): Promise<ToolkitJobResponse> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/update`, { version });
  }

  /** Check installed toolkits for newer versions. Omit `ids` to check all. */
  checkUpdates(ids?: string[]): Promise<CheckUpdatesResponse> {
    return this.client.post("/api/v1/toolkits/check-updates", { ids });
  }

  listTools(id: string): Promise<ListToolkitToolsResponse> {
    return this.client.get(`/api/v1/toolkits/${encodeURIComponent(id)}/tools`);
  }

  // Re-pin the current on-disk content + clear the drift warning.
  confirmReenable(id: string): Promise<ToolkitActionResponse> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/confirm-reenable`, {});
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

  setUndeclaredPolicy(id: string, policy: UndeclaredPolicy): Promise<Toolkit> {
    return this.client.post(`/api/v1/toolkits/${encodeURIComponent(id)}/undeclared-policy`, {
      policy,
    });
  }

  reindex(): Promise<{ embedded: number }> {
    return this.client.post("/api/v1/toolkits/reindex", {});
  }

  rescan(): Promise<{ added: number; updated: number; removed: number }> {
    return this.client.post("/api/v1/toolkits/rescan", {});
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
