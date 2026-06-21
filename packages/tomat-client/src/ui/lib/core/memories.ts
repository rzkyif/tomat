// Memory CRUD + rescan wrappers around the core REST API. Memories live
// on the core (markdown files + index rows); the client only mirrors the
// metadata list for the settings manager and the @-autocomplete.

import type { Memory, MemoryMeta } from "@tomat/shared";
import type { CoreClient } from "./client";

export class MemoriesApi {
  constructor(private readonly client: CoreClient) {}

  async list(): Promise<MemoryMeta[]> {
    const res = await this.client.get<{ memories: MemoryMeta[] }>("/api/v1/memories");
    return res.memories;
  }

  create(title: string, content = ""): Promise<Memory> {
    return this.client.post("/api/v1/memories", { title, content });
  }

  get(id: string): Promise<Memory> {
    return this.client.get(`/api/v1/memories/${encodeURIComponent(id)}`);
  }

  update(id: string, patch: { title?: string; content?: string }): Promise<Memory> {
    return this.client.patch(`/api/v1/memories/${encodeURIComponent(id)}`, patch);
  }

  delete(id: string): Promise<void> {
    return this.client.del(`/api/v1/memories/${encodeURIComponent(id)}`) as Promise<void>;
  }

  rescan(): Promise<{ added: number; removed: number; changed: number }> {
    return this.client.post("/api/v1/memories/rescan", {});
  }
}
