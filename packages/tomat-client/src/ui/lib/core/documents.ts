// Document CRUD + rescan wrappers around the core REST API. Documents live
// on the core (markdown files + index rows); the client only mirrors the
// metadata list for the settings manager and the @-autocomplete.

import type { Document, DocumentMeta } from "@tomat/shared";
import type { CoreClient } from "./client";

export class DocumentsApi {
  constructor(private readonly client: CoreClient) {}

  async list(): Promise<DocumentMeta[]> {
    const res = await this.client.get<{ documents: DocumentMeta[] }>("/api/v1/documents");
    return res.documents;
  }

  create(title: string, content = ""): Promise<Document> {
    return this.client.post("/api/v1/documents", { title, content });
  }

  get(id: string): Promise<Document> {
    return this.client.get(`/api/v1/documents/${encodeURIComponent(id)}`);
  }

  update(id: string, patch: { title?: string; content?: string }): Promise<Document> {
    return this.client.patch(`/api/v1/documents/${encodeURIComponent(id)}`, patch);
  }

  delete(id: string): Promise<void> {
    return this.client.del(`/api/v1/documents/${encodeURIComponent(id)}`) as Promise<void>;
  }

  rescan(): Promise<{ added: number; removed: number; changed: number }> {
    return this.client.post("/api/v1/documents/rescan", {});
  }
}
