// Document shapes shared between core and client. A document is a markdown
// file in the core's document store; metadata plus the background-generated
// summary live in SQLite, content is loaded on get.

export interface DocumentMeta {
  id: string;
  title: string;
  // File name under the core's documents directory; derived from the title.
  filename: string;
  contentHash: string;
  // LLM-generated; absent until the background indexer has run.
  summary?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface Document extends DocumentMeta {
  content: string;
}
