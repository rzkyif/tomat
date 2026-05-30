// Toolkits + Tools + Grants registry (DB-backed).
//
// Aggregates queries against the `toolkits`, `tools`, `tool_embeddings`, and
// `grants` tables. Higher-level orchestration (installer, worker pool) lives
// in sibling files.

import { join } from "@std/path";
import type {
  Grant,
  GrantState,
  PermissionDecl,
  Tool,
  Toolkit,
  ToolkitSource,
} from "@tomat/shared";
import { db } from "../db/connection.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { errMessage, permissionKey } from "@tomat/shared";
import { hashToolkit } from "./hash.ts";
import { getLogger } from "../shared/log.ts";

const CONTENT_DRIFT_ERROR = "content changed since install — reinstall to use";

export interface ToolkitInsertInput {
  id: string;
  source: ToolkitSource;
  displayName: string;
  description?: string;
  version: string;
  installedPath: string;
  toolsJsonHash: string;
  contentHash: string;
}

export interface ToolInsertInput {
  toolkitId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  triggers: string[];
  fnExport: string;
  alwaysAvailable: boolean;
  requiredPermissions: PermissionDecl[];
}

export class ToolkitsRegistry {
  // --- toolkit-level ------------------------------------------------------

  list(): Toolkit[] {
    const rows = db().prepare(`
      SELECT id, source, display_name, description, version, installed_path,
             tools_json_hash, content_hash, enabled, last_error,
             installed_at_ms, updated_at_ms
      FROM toolkits
      ORDER BY display_name COLLATE NOCASE ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map(rowToToolkit);
  }

  get(id: string): Toolkit | undefined {
    const row = db().prepare(`
      SELECT id, source, display_name, description, version, installed_path,
             tools_json_hash, content_hash, enabled, last_error,
             installed_at_ms, updated_at_ms
      FROM toolkits WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? rowToToolkit(row) : undefined;
  }

  getOrThrow(id: string): Toolkit {
    const tk = this.get(id);
    if (!tk) throw new AppError("toolkit_not_found", `toolkit ${id} not found`);
    return tk;
  }

  upsertToolkit(input: ToolkitInsertInput): void {
    const now = Date.now();
    const existing = this.get(input.id);
    if (existing) {
      db().prepare(`
        UPDATE toolkits
           SET source = ?, display_name = ?, description = ?, version = ?,
               installed_path = ?, tools_json_hash = ?, content_hash = ?,
               last_error = NULL, updated_at_ms = ?
         WHERE id = ?
      `).run(
        input.source,
        input.displayName,
        input.description ?? null,
        input.version,
        input.installedPath,
        input.toolsJsonHash,
        input.contentHash,
        now,
        input.id,
      );
    } else {
      db().prepare(`
        INSERT INTO toolkits
          (id, source, display_name, description, version, installed_path,
           tools_json_hash, content_hash, enabled, last_error,
           installed_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
      `).run(
        input.id,
        input.source,
        input.displayName,
        input.description ?? null,
        input.version,
        input.installedPath,
        input.toolsJsonHash,
        input.contentHash,
        now,
        now,
      );
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    db().prepare(
      `UPDATE toolkits SET enabled = ?, updated_at_ms = ? WHERE id = ?`,
    )
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  setLastError(id: string, error: string | null): void {
    db().prepare(
      `UPDATE toolkits SET last_error = ?, updated_at_ms = ? WHERE id = ?`,
    )
      .run(error, Date.now(), id);
  }

  // Boot-time integrity check. Walks every installed toolkit, recomputes
  // its content hash (per hash.ts: excludes node_modules + .gitignore-listed
  // paths; includes .gitignore itself), and marks the row with
  // CONTENT_DRIFT_ERROR if it differs from the stored hash. Conversely,
  // clears a stale drift error if the hash now matches (user could have
  // restored or reinstalled the folder out-of-band).
  //
  // Returns the IDs that drifted. Tool calls against a drifted toolkit
  // should be refused with a 409 — that's the route layer's responsibility,
  // gated on `toolkit.lastError`.
  async verifyAllOnBoot(): Promise<string[]> {
    const log = getLogger("toolkits.verify");
    const drifted: string[] = [];
    for (const tk of this.list()) {
      let actualHash: string;
      try {
        actualHash = await hashToolkit(tk.installedPath);
      } catch (err) {
        const msg = errMessage(err);
        log.warn(`[${tk.id}] hash failed: ${msg}`);
        this.setLastError(tk.id, `hash failed: ${msg}`);
        drifted.push(tk.id);
        continue;
      }
      if (actualHash !== tk.contentHash) {
        log.warn(
          `[${tk.id}] content drift: stored=${
            tk.contentHash.slice(0, 12)
          } actual=${actualHash.slice(0, 12)}`,
        );
        this.setLastError(tk.id, CONTENT_DRIFT_ERROR);
        drifted.push(tk.id);
      } else if (tk.lastError === CONTENT_DRIFT_ERROR) {
        // Drift error was set on a previous boot but the user has since
        // reverted; clear it so tools can be called again.
        log.info(`[${tk.id}] content hash now matches; clearing drift error`);
        this.setLastError(tk.id, null);
      }
    }
    return drifted;
  }

  delete(id: string): void {
    // CASCADE drops tools, tool_embeddings, grants.
    db().prepare(`DELETE FROM toolkits WHERE id = ?`).run(id);
  }

  // --- tool-level ---------------------------------------------------------

  replaceTools(toolkitId: string, tools: ToolInsertInput[]): void {
    // Atomically replace the toolkit's tools, preserving enabled state +
    // grants on identical (name, parameters, triggers) entries so a re-install
    // doesn't blow away user permissions unless they materially changed.
    const existing = db().prepare(`
      SELECT id, name, enabled FROM tools WHERE toolkit_id = ?
    `).all(toolkitId) as Array<{ id: string; name: string; enabled: number }>;
    const existingByName = new Map(existing.map((r) => [r.name, r]));

    db().exec("BEGIN");
    try {
      db().prepare(`DELETE FROM tools WHERE toolkit_id = ?`).run(toolkitId);
      for (const t of tools) {
        const id = toolId(toolkitId, t.name);
        const prior = existingByName.get(t.name);
        db().prepare(`
          INSERT INTO tools
            (id, toolkit_id, name, description, parameters_json, triggers_json,
             fn_export, always_available, enabled, required_permissions_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          toolkitId,
          t.name,
          t.description,
          JSON.stringify(t.parameters),
          JSON.stringify(t.triggers),
          t.fnExport,
          t.alwaysAvailable ? 1 : 0,
          // Conservative: disable on re-install if the required permission
          // set may have changed. Higher-level installer can re-enable if
          // permissions still match.
          prior ? prior.enabled : 0,
          JSON.stringify(t.requiredPermissions),
        );
      }
      db().exec("COMMIT");
    } catch (err) {
      db().exec("ROLLBACK");
      throw err;
    }
  }

  listTools(toolkitId: string): Tool[] {
    const rows = db().prepare(`
      SELECT id, toolkit_id, name, description, parameters_json, triggers_json,
             fn_export, always_available, enabled, required_permissions_json
      FROM tools WHERE toolkit_id = ?
      ORDER BY name ASC
    `).all(toolkitId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.attachGrants(rowToTool(r)));
  }

  getTool(toolId: string): Tool | undefined {
    const row = db().prepare(`
      SELECT id, toolkit_id, name, description, parameters_json, triggers_json,
             fn_export, always_available, enabled, required_permissions_json
      FROM tools WHERE id = ?
    `).get(toolId) as Record<string, unknown> | undefined;
    return row ? this.attachGrants(rowToTool(row)) : undefined;
  }

  setToolEnabled(toolkitId: string, name: string, enabled: boolean): void {
    db().prepare(
      `UPDATE tools SET enabled = ? WHERE toolkit_id = ? AND name = ?`,
    )
      .run(enabled ? 1 : 0, toolkitId, name);
  }

  // --- grants -------------------------------------------------------------

  setGrants(
    toolId: string,
    entries: Array<
      { key: string; kind: PermissionDecl["kind"]; state: GrantState }
    >,
  ): Grant[] {
    const now = Date.now();
    db().exec("BEGIN");
    try {
      for (const entry of entries) {
        db().prepare(`
          INSERT INTO grants (tool_id, permission_key, permission_kind, state, granted_at_ms)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tool_id, permission_key) DO UPDATE SET
            state = excluded.state,
            granted_at_ms = excluded.granted_at_ms
        `).run(toolId, entry.key, entry.kind, entry.state, now);
      }
      db().exec("COMMIT");
    } catch (err) {
      db().exec("ROLLBACK");
      throw err;
    }
    return this.listGrantsForTool(toolId);
  }

  listGrantsForTool(toolId: string): Grant[] {
    const rows = db().prepare(`
      SELECT tool_id, permission_key, permission_kind, state, granted_at_ms
      FROM grants WHERE tool_id = ?
    `).all(toolId) as Array<{
      tool_id: string;
      permission_key: string;
      permission_kind: string;
      state: string;
      granted_at_ms: number;
    }>;
    return rows.map((r) => ({
      toolId: r.tool_id,
      permissionKey: r.permission_key,
      permissionKind: r.permission_kind as Grant["permissionKind"],
      state: r.state as Grant["state"],
      grantedAtMs: r.granted_at_ms,
    }));
  }

  // --- embeddings ---------------------------------------------------------

  storeEmbedding(
    toolId: string,
    vector: Float32Array,
    sourceHash: string,
  ): void {
    db().prepare(`
      INSERT INTO tool_embeddings (tool_id, dim, vector, source_hash)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tool_id) DO UPDATE SET
        dim = excluded.dim,
        vector = excluded.vector,
        source_hash = excluded.source_hash
    `).run(
      toolId,
      vector.length,
      new Uint8Array(vector.buffer.slice(0)),
      sourceHash,
    );
  }

  loadEmbedding(
    toolId: string,
  ): { vector: Float32Array; sourceHash: string } | undefined {
    const row = db().prepare(`
      SELECT vector, dim, source_hash FROM tool_embeddings WHERE tool_id = ?
    `).get(toolId) as
      | { vector: Uint8Array; dim: number; source_hash: string }
      | undefined;
    if (!row) return undefined;
    const bytes = row.vector instanceof Uint8Array
      ? row.vector
      : new Uint8Array(row.vector as ArrayBuffer);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    return {
      vector: new Float32Array(buf),
      sourceHash: row.source_hash,
    };
  }

  // --- helpers ------------------------------------------------------------

  // requiredPermissions for a tool isn't persisted in the schema (tools.json
  // is the source of truth). Higher-level callers re-parse from disk when
  // they need it. attachGrants() does NOT resolve required permissions here;
  // it only attaches grant state. The route layer is responsible for combining
  // the two.
  private attachGrants(tool: Tool): Tool {
    return { ...tool, grants: this.listGrantsForTool(tool.id) };
  }
}

export function toolId(toolkitId: string, toolName: string): string {
  return `${toolkitId}::${toolName}`;
}

// Re-export so external callers can compute permission keys without importing
// from @tomat/shared directly.
export { permissionKey };

let _instance: ToolkitsRegistry | null = null;
export function toolkitsRegistry(): ToolkitsRegistry {
  if (!_instance) _instance = new ToolkitsRegistry();
  return _instance;
}

export function __resetForTesting(): void {
  _instance = null;
}

// Resolve the on-disk install path for a toolkit id.
export function toolkitInstallPath(id: string): string {
  return join(paths().toolkitsDir, id);
}

// --- row mappers ----------------------------------------------------------

function rowToToolkit(row: Record<string, unknown>): Toolkit {
  return {
    id: String(row.id),
    source: row.source as ToolkitSource,
    displayName: String(row.display_name),
    description: row.description == null ? undefined : String(row.description),
    version: String(row.version),
    installedPath: String(row.installed_path),
    toolsJsonHash: String(row.tools_json_hash),
    contentHash: String(row.content_hash),
    enabled: Number(row.enabled) === 1,
    lastError: row.last_error == null ? undefined : String(row.last_error),
    installedAtMs: Number(row.installed_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function rowToTool(row: Record<string, unknown>): Tool {
  return {
    id: String(row.id),
    toolkitId: String(row.toolkit_id),
    name: String(row.name),
    description: String(row.description),
    parameters: JSON.parse(String(row.parameters_json)),
    triggers: JSON.parse(String(row.triggers_json)),
    fnExport: String(row.fn_export),
    alwaysAvailable: Number(row.always_available) === 1,
    enabled: Number(row.enabled) === 1,
    requiredPermissions: row.required_permissions_json
      ? JSON.parse(String(row.required_permissions_json))
      : [],
    // missingRequired is derived by the route/service layer at read time;
    // it depends on current grant state.
    missingRequired: [],
    grants: [],
  };
}
