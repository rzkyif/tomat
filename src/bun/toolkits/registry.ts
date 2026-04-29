import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolkitKind, ToolkitRow, ToolRow } from "./types";

export type ToolkitState = "untrusted" | "disabled" | "enabled";

// Schema lives alongside the DB file inside ~/.tomat/toolkits/. The row itself
// is kept around even after untrust so repeat scans don't lose history
// (metadata cache, last_error, etc).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS toolkits (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  entry_path      TEXT NOT NULL,
  display_name    TEXT,
  description     TEXT,
  state           TEXT NOT NULL DEFAULT 'untrusted',
  content_hash    TEXT,
  metadata_json   TEXT,
  last_error      TEXT,
  entry_mtime_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS tools (
  id              TEXT PRIMARY KEY,
  toolkit_id      TEXT NOT NULL REFERENCES toolkits(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  triggers_json   TEXT NOT NULL,
  fn_export       TEXT NOT NULL,
  UNIQUE(toolkit_id, name)
);

CREATE TABLE IF NOT EXISTS tool_embeddings (
  tool_id     TEXT PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  source_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tools_toolkit ON tools(toolkit_id);
`;

export interface ToolkitRecord {
  id: string;
  kind: ToolkitKind;
  entry_path: string;
  display_name: string | null;
  description: string | null;
  state: ToolkitState;
  content_hash: string | null;
  metadata_json: string | null;
  last_error: string | null;
  entry_mtime_ms: number | null;
}

export interface ToolRecord {
  id: string;
  toolkit_id: string;
  name: string;
  description: string;
  parameters_json: string;
  triggers_json: string;
  fn_export: string;
}

export interface ToolEmbedding {
  tool_id: string;
  dim: number;
  vector: Uint8Array;
  source_hash: string;
}

/** Derived filesystem-backed status for a toolkit folder. File-kind toolkits
 *  never have dependencies. */
export interface DerivedStatus {
  hasDeps: boolean;
  depsInstalled: boolean;
}

/** Inspect the toolkit folder on disk to answer "does it have dependencies?"
 *  and "are they installed right now?". File-kind toolkits always return
 *  false/false. Results are NOT cached — cheap to recompute.
 *  - hasDeps: `package.json` exists and its `dependencies` object is a
 *    non-empty record.
 *  - depsInstalled: `node_modules/` exists as a directory. */
export function deriveStatus(entryPath: string, kind: ToolkitKind): DerivedStatus {
  if (kind !== "folder") return { hasDeps: false, depsInstalled: false };
  const folder = path.dirname(entryPath);

  let hasDeps = false;
  const pkgPath = path.join(folder, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    const deps = parsed && typeof parsed === "object" ? parsed.dependencies : undefined;
    hasDeps = !!deps && typeof deps === "object" && Object.keys(deps).length > 0;
  } catch {
    hasDeps = false;
  }

  let depsInstalled = false;
  try {
    const stat = fs.statSync(path.join(folder, "node_modules"));
    depsInstalled = stat.isDirectory();
  } catch {
    depsInstalled = false;
  }

  return { hasDeps, depsInstalled };
}

export class ToolkitsRegistry {
  readonly db: Database;

  constructor(readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    // WAL: much better concurrency for the Elysia server's interleaved reads
    // during scan + writes during enable.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      console.error("[toolkits] db close failed:", err);
    }
  }

  getToolkit(id: string): ToolkitRecord | null {
    const row = this.db.query("SELECT * FROM toolkits WHERE id = ?").get(id) as
      | ToolkitRecord
      | undefined;
    return row ?? null;
  }

  listToolkits(): ToolkitRecord[] {
    return this.db.query("SELECT * FROM toolkits ORDER BY id").all() as ToolkitRecord[];
  }

  upsertDiscovered(entry: {
    id: string;
    kind: ToolkitKind;
    entryPath: string;
    entryMtimeMs: number | null;
  }): void {
    const existing = this.getToolkit(entry.id);
    if (existing) {
      this.db
        .query(
          `UPDATE toolkits
           SET kind = ?, entry_path = ?, entry_mtime_ms = ?
           WHERE id = ?`,
        )
        .run(entry.kind, entry.entryPath, entry.entryMtimeMs, entry.id);
    } else {
      this.db
        .query(
          `INSERT INTO toolkits (id, kind, entry_path, entry_mtime_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(entry.id, entry.kind, entry.entryPath, entry.entryMtimeMs);
    }
  }

  deleteToolkit(id: string): void {
    this.db.query("DELETE FROM toolkits WHERE id = ?").run(id);
  }

  setState(id: string, state: ToolkitState): void {
    this.db.query(`UPDATE toolkits SET state = ? WHERE id = ?`).run(state, id);
  }

  setContentHash(id: string, hash: string | null): void {
    this.db.query(`UPDATE toolkits SET content_hash = ? WHERE id = ?`).run(hash, id);
  }

  /** Move from 'untrusted' to 'disabled', pin the content hash, and clear any
   *  previous error. */
  trust(id: string, contentHash: string | null): void {
    this.db
      .query(
        `UPDATE toolkits SET state = 'disabled', content_hash = ?, last_error = NULL WHERE id = ?`,
      )
      .run(contentHash, id);
  }

  /** Mark enabled, optionally stashing the last-seen metadata JSON. */
  enable(id: string, metadataJson: string | null): void {
    if (metadataJson !== null) {
      this.db
        .query(
          `UPDATE toolkits SET state = 'enabled', metadata_json = ?, last_error = NULL WHERE id = ?`,
        )
        .run(metadataJson, id);
    } else {
      this.db.query(`UPDATE toolkits SET state = 'enabled' WHERE id = ?`).run(id);
    }
  }

  /** Walk back to 'disabled' — keeps trust + cached metadata. */
  disable(id: string): void {
    this.db.query(`UPDATE toolkits SET state = 'disabled' WHERE id = ?`).run(id);
  }

  setMetadata(id: string, data: { displayName: string; description: string }): void {
    this.db
      .query(`UPDATE toolkits SET display_name = ?, description = ? WHERE id = ?`)
      .run(data.displayName, data.description, id);
  }

  setLastError(id: string, error: string | null): void {
    this.db.query(`UPDATE toolkits SET last_error = ? WHERE id = ?`).run(error, id);
  }

  /** Flip back to 'untrusted' and wipe cached metadata + tools. The row
   *  itself is kept (id/kind/entry_path) so a re-scan isn't needed. */
  clearTrust(id: string): void {
    this.db
      .query(
        `UPDATE toolkits
         SET state = 'untrusted', content_hash = NULL, metadata_json = NULL,
             display_name = NULL, description = NULL
         WHERE id = ?`,
      )
      .run(id);
    this.db.query(`DELETE FROM tools WHERE toolkit_id = ?`).run(id);
  }

  replaceTools(
    toolkitId: string,
    tools: {
      name: string;
      description: string;
      parametersJson: string;
      triggersJson: string;
      fnExport: string;
    }[],
  ): ToolRecord[] {
    this.db.transaction(() => {
      this.db.query(`DELETE FROM tools WHERE toolkit_id = ?`).run(toolkitId);
      const insert = this.db.query(
        `INSERT INTO tools (id, toolkit_id, name, description, parameters_json, triggers_json, fn_export)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const t of tools) {
        const toolId = `${toolkitId}:${t.name}`;
        insert.run(
          toolId,
          toolkitId,
          t.name,
          t.description,
          t.parametersJson,
          t.triggersJson,
          t.fnExport,
        );
      }
    })();

    return this.db.query(`SELECT * FROM tools WHERE toolkit_id = ?`).all(toolkitId) as ToolRecord[];
  }

  listToolsForEnabled(): ToolRecord[] {
    return this.db
      .query(
        `SELECT t.* FROM tools t
         JOIN toolkits k ON k.id = t.toolkit_id
         WHERE k.state = 'enabled'`,
      )
      .all() as ToolRecord[];
  }

  listToolsByIds(ids: string[]): ToolRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .query(`SELECT * FROM tools WHERE id IN (${placeholders})`)
      .all(...ids) as ToolRecord[];
  }

  getTool(toolkitId: string, name: string): ToolRecord | null {
    const r = this.db
      .query(`SELECT * FROM tools WHERE toolkit_id = ? AND name = ?`)
      .get(toolkitId, name) as ToolRecord | undefined;
    return r ?? null;
  }

  upsertEmbedding(toolId: string, dim: number, vector: Float32Array, sourceHash: string): void {
    const blob = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db
      .query(
        `INSERT INTO tool_embeddings (tool_id, dim, vector, source_hash)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET dim = excluded.dim, vector = excluded.vector, source_hash = excluded.source_hash`,
      )
      .run(toolId, dim, blob, sourceHash);
  }

  getEmbedding(toolId: string): ToolEmbedding | null {
    const row = this.db.query(`SELECT * FROM tool_embeddings WHERE tool_id = ?`).get(toolId) as
      | ToolEmbedding
      | undefined;
    return row ?? null;
  }

  /** Count how many tools in a given toolkit currently have an embedding row.
   *  Used by the UI to show "Indexing N/M" so the user can tell whether a
   *  freshly-enabled toolkit is ready for phase-1 vector search. */
  countEmbeddingsForToolkit(toolkitId: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS c
         FROM tool_embeddings e
         JOIN tools t ON t.id = e.tool_id
         WHERE t.toolkit_id = ?`,
      )
      .get(toolkitId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  listEmbeddingsForEnabled(): Array<
    ToolEmbedding & { name: string; toolkit_id: string; description: string }
  > {
    return this.db
      .query(
        `SELECT e.tool_id, e.dim, e.vector, e.source_hash, t.name, t.toolkit_id, t.description
         FROM tool_embeddings e
         JOIN tools t ON t.id = e.tool_id
         JOIN toolkits k ON k.id = t.toolkit_id
         WHERE k.state = 'enabled'`,
      )
      .all() as Array<ToolEmbedding & { name: string; toolkit_id: string; description: string }>;
  }

  // --- Row -> API mapping helpers

  rowToPublic(rec: ToolkitRecord, tools: ToolRecord[] = []): ToolkitRow {
    const { hasDeps, depsInstalled } = deriveStatus(rec.entry_path, rec.kind);
    return {
      id: rec.id,
      kind: rec.kind,
      entryPath: rec.entry_path,
      displayName: rec.display_name,
      description: rec.description,
      trusted: rec.state !== "untrusted",
      depsInstalled,
      hasPackage: hasDeps,
      enabled: rec.state === "enabled",
      lastError: rec.last_error,
      tools: tools.map(toolRecordToPublic),
      embeddedToolCount: this.countEmbeddingsForToolkit(rec.id),
    };
  }
}

export function toolRecordToPublic(rec: ToolRecord): ToolRow {
  return {
    id: rec.id,
    toolkitId: rec.toolkit_id,
    name: rec.name,
    description: rec.description,
    triggers: safeJsonArray(rec.triggers_json),
    parameters: safeJsonObject(rec.parameters_json),
    fnExport: rec.fn_export,
  };
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
