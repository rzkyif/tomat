// Document store: markdown files under ~/.tomat/<channel>/core/documents/
// are the source of truth; SQLite (`documents`) carries metadata plus the
// background-generated summary + embedding. `rescan()` reconciles the two
// by content hash, so files edited or dropped in by hand (or another sync
// mechanism) become first-class documents on the next scan.
//
// Synchronous fs (and synchronous hashing) for the same reasons as
// sessions-store.ts: call sites are sync (broker ops, chat prompt assembly),
// and a method that never yields to the event loop can't interleave with
// another caller's read-modify-write.

import { join } from "@std/path";
import type { Document, DocumentMeta } from "@tomat/shared";
import { db } from "../db/connection.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { sha256HexSync } from "../shared/hash.ts";
import { newDocumentId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("documents");

export class DocumentsStore {
  list(): DocumentMeta[] {
    const rows = db()
      .prepare(`${META_SELECT} ORDER BY title COLLATE NOCASE ASC`)
      .all() as MetaRow[];
    return rows.map(rowToMeta);
  }

  get(id: string): Document {
    const meta = this.metaOrThrow(id);
    return { ...meta, content: readContent(meta.filename) };
  }

  // Case-insensitive lookup: titles are unique COLLATE NOCASE (see create),
  // and tools address documents by the title they saw in the prompt, which
  // the model may re-case.
  getByTitle(title: string): Document | undefined {
    const row = db().prepare(`${META_SELECT} WHERE title = ? COLLATE NOCASE`).get(title) as
      | MetaRow
      | undefined;
    if (!row) return undefined;
    const meta = rowToMeta(row);
    return { ...meta, content: readContent(meta.filename) };
  }

  create(title: string, content: string): Document {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new AppError("validation_error", "document title required");
    // NOCASE: "Notes" next to "notes" would be two rows tools can't tell
    // apart through the title-keyed API.
    if (this.titleExists(cleanTitle)) {
      throw new AppError("conflict", `document "${cleanTitle}" already exists`);
    }
    const id = newDocumentId();
    const filename = uniqueFilename(cleanTitle);
    const hash = sha256HexSync(content);
    const now = Date.now();
    // Write the file BEFORE the row so a failed write can never leave a row
    // pointing at a missing file. rescan() tolerates an orphan file, so if the
    // INSERT then fails we remove the file to avoid a stray (best-effort).
    writeContent(filename, content);
    try {
      db()
        .prepare(`
        INSERT INTO documents (id, title, filename, content_hash, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .run(id, cleanTitle, filename, hash, now, now);
    } catch (err) {
      try {
        Deno.removeSync(join(paths().documentsDir, filename));
      } catch {
        /* best-effort; rescan would otherwise re-adopt the orphan file */
      }
      throw err;
    }
    return this.get(id);
  }

  replaceContent(id: string, content: string): Document {
    const meta = this.metaOrThrow(id);
    const hash = sha256HexSync(content);
    db()
      .prepare(`UPDATE documents SET content_hash = ?, updated_at_ms = ? WHERE id = ?`)
      .run(hash, Date.now(), id);
    writeContent(meta.filename, content);
    return this.get(id);
  }

  /** Exact single-occurrence find/replace. Errors when `find` matches zero
   *  times or more than once, so the caller can correct its anchor instead
   *  of silently editing the wrong spot. Returns the before/after contents
   *  for the diff bubble. */
  editContent(
    id: string,
    find: string,
    replace: string,
  ): { document: Document; before: string; after: string } {
    if (find.length === 0) throw new AppError("validation_error", "find text must not be empty");
    const meta = this.metaOrThrow(id);
    const before = readContent(meta.filename);
    const first = before.indexOf(find);
    if (first === -1) {
      throw new AppError("validation_error", "find text not found in document");
    }
    if (before.indexOf(find, first + 1) !== -1) {
      throw new AppError(
        "validation_error",
        "find text matches more than once; include more surrounding context",
      );
    }
    const after = before.slice(0, first) + replace + before.slice(first + find.length);
    const document = this.replaceContent(id, after);
    return { document, before, after };
  }

  rename(id: string, title: string): DocumentMeta {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new AppError("validation_error", "document title required");
    const meta = this.metaOrThrow(id);
    if (cleanTitle === meta.title) return meta;
    if (this.titleExists(cleanTitle, id)) {
      throw new AppError("conflict", `document "${cleanTitle}" already exists`);
    }
    // The file keeps its name: filenames only need to be stable and unique,
    // and a rename that also moved the file would break external references
    // for no user-visible gain. Re-derive happens naturally on rescan if the
    // file is recreated.
    db()
      .prepare(`UPDATE documents SET title = ?, updated_at_ms = ? WHERE id = ?`)
      .run(cleanTitle, Date.now(), id);
    return this.metaOrThrow(id);
  }

  delete(id: string): void {
    const meta = this.metaOrThrow(id);
    db().prepare(`DELETE FROM documents WHERE id = ?`).run(id);
    try {
      Deno.removeSync(join(paths().documentsDir, meta.filename));
    } catch {
      /* already gone */
    }
  }

  /** Reconcile rows with the files on disk. New .md files become documents
   *  (title from the filename stem); rows whose file vanished are dropped;
   *  rows whose file content drifted get their hash bumped so the indexer
   *  refreshes summary + embedding. Returns counts for the route response. */
  rescan(): { added: number; removed: number; changed: number } {
    const dir = paths().documentsDir;
    const onDisk = new Map<string, string>(); // filename -> content
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;
      try {
        onDisk.set(entry.name, readContent(entry.name));
      } catch {
        // Vanished between readDir and read; the next rescan settles it.
      }
    }
    let added = 0;
    let removed = 0;
    let changed = 0;
    const now = Date.now();
    // One transaction so the table is reconciled atomically (the loops below run
    // many statements); a mid-rescan failure rolls back rather than leaving the
    // index half-updated. Mirrors registry.ts replaceTools().
    db().exec("BEGIN");
    try {
      for (const row of this.list()) {
        const content = onDisk.get(row.filename);
        if (content === undefined) {
          db().prepare(`DELETE FROM documents WHERE id = ?`).run(row.id);
          removed++;
          continue;
        }
        onDisk.delete(row.filename);
        const hash = sha256HexSync(content);
        if (hash !== row.contentHash) {
          db()
            .prepare(`UPDATE documents SET content_hash = ?, updated_at_ms = ? WHERE id = ?`)
            .run(hash, now, row.id);
          changed++;
        }
      }
      for (const [filename, content] of onDisk) {
        const title = uniqueTitle(filename.replace(/\.md$/, ""));
        db()
          .prepare(`
          INSERT INTO documents (id, title, filename, content_hash, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
          .run(newDocumentId(), title, filename, sha256HexSync(content), now, now);
        added++;
      }
      db().exec("COMMIT");
    } catch (err) {
      db().exec("ROLLBACK");
      throw err;
    }
    if (added || removed || changed) {
      log.info(`rescan: ${added} added, ${removed} removed, ${changed} changed`);
    }
    return { added, removed, changed };
  }

  // --- index bookkeeping (used by the background indexer) ------------------

  setSummary(id: string, summary: string, sourceHash: string): void {
    db()
      .prepare(`UPDATE documents SET summary = ?, summary_source_hash = ? WHERE id = ?`)
      .run(summary, sourceHash, id);
  }

  setEmbedding(id: string, vector: Float32Array, sourceHash: string): void {
    db()
      .prepare(`
      UPDATE documents
         SET embedding = ?, embedding_dim = ?, embedding_source_hash = ?
       WHERE id = ?
    `)
      .run(new Uint8Array(vector.buffer.slice(0)), vector.length, sourceHash, id);
  }

  /** Index state for the background indexer: content hash + which hashes the
   *  stored summary/embedding were derived from. */
  listIndexStates(): Array<{
    id: string;
    contentHash: string;
    summarySourceHash: string | null;
    embeddingSourceHash: string | null;
  }> {
    const rows = db()
      .prepare(`
      SELECT id, content_hash, summary_source_hash, embedding_source_hash FROM documents
    `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      contentHash: String(r.content_hash),
      summarySourceHash: r.summary_source_hash == null ? null : String(r.summary_source_hash),
      embeddingSourceHash: r.embedding_source_hash == null ? null : String(r.embedding_source_hash),
    }));
  }

  /** All document embeddings, for relevance scoring at prompt time. */
  loadAllEmbeddings(): Map<string, Float32Array> {
    const rows = db()
      .prepare(`SELECT id, embedding, embedding_dim FROM documents WHERE embedding IS NOT NULL`)
      .all() as Array<{ id: string; embedding: Uint8Array; embedding_dim: number }>;
    const out = new Map<string, Float32Array>();
    for (const row of rows) {
      const bytes = row.embedding;
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      out.set(String(row.id), new Float32Array(copy, 0, Number(row.embedding_dim)));
    }
    return out;
  }

  // --- internals ------------------------------------------------------------

  private metaOrThrow(id: string): DocumentMeta {
    const row = db().prepare(`${META_SELECT} WHERE id = ?`).get(id) as MetaRow | undefined;
    if (!row) throw new AppError("not_found", `document ${id} not found`);
    return rowToMeta(row);
  }

  private titleExists(title: string, excludeId?: string): boolean {
    const row = db()
      .prepare(`SELECT id FROM documents WHERE title = ? COLLATE NOCASE`)
      .get(title) as { id: string } | undefined;
    return row !== undefined && row.id !== excludeId;
  }
}

let _instance: DocumentsStore | null = null;
export function documentsStore(): DocumentsStore {
  if (!_instance) _instance = new DocumentsStore();
  return _instance;
}

// Test-only: drops the cached instance.
export function __resetForTesting(): void {
  _instance = null;
}

// --- helpers ----------------------------------------------------------------

const META_SELECT = `
  SELECT id, title, filename, content_hash, summary, created_at_ms, updated_at_ms
  FROM documents`;

interface MetaRow {
  id: string;
  title: string;
  filename: string;
  content_hash: string;
  summary: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function rowToMeta(row: MetaRow): DocumentMeta {
  return {
    id: String(row.id),
    title: String(row.title),
    filename: String(row.filename),
    contentHash: String(row.content_hash),
    summary: row.summary == null ? undefined : String(row.summary),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function readContent(filename: string): string {
  try {
    return Deno.readTextFileSync(join(paths().documentsDir, filename));
  } catch {
    // Row exists but the file vanished (deleted by hand between rescans).
    // Surfacing the loss beats returning "" and letting a tool "read" or
    // overwrite an empty document it believes is real.
    throw new AppError(
      "not_found",
      `document file "${filename}" is missing on disk; run a documents rescan`,
    );
  }
}

// Atomic write (tmp + rename), mirroring sessions-store.writeDoc.
function writeContent(filename: string, content: string): void {
  const path = join(paths().documentsDir, filename);
  const tmp = path + ".tmp";
  Deno.writeTextFileSync(tmp, content);
  Deno.renameSync(tmp, path);
}

// "Meeting Notes: Q3!" -> "meeting-notes-q3.md", suffixed -2, -3, ... until
// it collides with neither a DB row nor a stray file on disk.
function uniqueFilename(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "document";
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${slug}.md` : `${slug}-${i}.md`;
    const inDb = db().prepare(`SELECT 1 FROM documents WHERE filename = ?`).get(name);
    if (inDb) continue;
    try {
      Deno.statSync(join(paths().documentsDir, name));
    } catch {
      return name; // not on disk either
    }
  }
}

// Title for a rescanned file, de-duplicated against existing rows the same
// way filenames are.
function uniqueTitle(stem: string): string {
  const base = stem.trim() || "Document";
  for (let i = 1; ; i++) {
    const title = i === 1 ? base : `${base} (${i})`;
    const exists = db()
      .prepare(`SELECT 1 FROM documents WHERE title = ? COLLATE NOCASE`)
      .get(title);
    if (!exists) return title;
  }
}
