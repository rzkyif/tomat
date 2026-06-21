// Memory shapes shared between core and client. A memory is a markdown
// file in the core's memory store; metadata plus the background-generated
// summary live in SQLite, content is loaded on get.

export interface MemoryMeta {
  id: string;
  title: string;
  // File name under the core's memories directory; derived from the title.
  filename: string;
  contentHash: string;
  // LLM-generated; absent until the background indexer has run.
  summary?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface Memory extends MemoryMeta {
  content: string;
}
