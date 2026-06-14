/**
 * Reactive mirror of the active core's document list. Documents live on the
 * core (markdown files + index rows); the client caches the metadata for the
 * Documents settings manager and the @-autocomplete. The cache reloads on
 * every WS connect, so it follows core switches and reconnects.
 */

import type { Document, DocumentMeta } from "@tomat/shared";
import { cores } from "$lib/core";
import { getLogger } from "$lib/shared/log";

const log = getLogger("documents");

/** The @-token a document responds to: its filename stem ("meeting-notes.md"
 *  -> "@meeting-notes"). A stem with characters outside the bare-token set
 *  (a hand-placed file like "My Notes.md") uses the quoted form
 *  `@"my notes"`, which the matcher on both sides understands. The core
 *  resolves these tokens at generation time; the client only offers them in
 *  autocomplete and never expands them. */
export function documentTrigger(meta: DocumentMeta): string {
  const stem = meta.filename.replace(/\.md$/, "").toLowerCase();
  return /^[a-z0-9_-]+$/.test(stem) ? `@${stem}` : `@"${stem}"`;
}

class DocumentsState {
  documents = $state<DocumentMeta[]>([]);

  private unsubscribeConn: (() => void) | null = null;

  /** Subscribe to the active core's connection state and (re)load the list on
   *  every connected edge. Idempotent, mirroring toolkitsState.attach(). */
  attach(): void {
    if (this.unsubscribeConn) return;
    this.unsubscribeConn = cores().subscribeConnectionState((state) => {
      if (state === "connected") {
        void this.load().catch((err) => log.warn("document load on ws connect failed:", err));
      }
    });
  }

  async load(): Promise<void> {
    this.documents = await cores().api().documents.list();
  }

  async create(title: string, content = ""): Promise<Document> {
    const doc = await cores().api().documents.create(title, content);
    await this.load();
    return doc;
  }

  get(id: string): Promise<Document> {
    return cores().api().documents.get(id);
  }

  async update(id: string, patch: { title?: string; content?: string }): Promise<Document> {
    const doc = await cores().api().documents.update(id, patch);
    await this.load();
    return doc;
  }

  async delete(id: string): Promise<void> {
    await cores().api().documents.delete(id);
    this.documents = this.documents.filter((d) => d.id !== id);
  }

  async rescan(): Promise<{ added: number; removed: number; changed: number }> {
    const result = await cores().api().documents.rescan();
    await this.load();
    return result;
  }
}

export const documentsState = new DocumentsState();
