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
  ToolkitStatus,
} from "@tomat/shared";
import { db } from "../db/connection.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { errMessage, permissionKey } from "@tomat/shared";
import { hashToolkit, statSignature } from "./hash.ts";
import { getLogger } from "../shared/log.ts";

// Human-readable last_error set when the content hash cannot even be computed
// at verify time (a real I/O error, distinct from the `drift` status which a
// plain content mismatch sets on its own).
const HASH_FAILED_PREFIX = "content hash failed";

export interface ToolkitInsertInput {
  id: string;
  source: ToolkitSource;
  displayName: string;
  description?: string;
  version: string;
  installedPath: string;
  toolsJsonHash: string;
  // Empty string until the toolkit is installed; download leaves it unpinned.
  contentHash: string;
  // Defaults to "downloaded" when omitted (the download path never installs).
  status?: ToolkitStatus;
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
  // Per-call hash-verify skip cache: toolkitId -> { sig, hash }. When the
  // stat signature (count + total size + newest mtime) across a toolkit's files
  // is unchanged from a prior successful verify, the content is very unlikely to
  // have changed, so the per-call re-hash is skipped. (mtime alone was forgeable
  // by a tool resetting its own files' mtime; see statSignature.)
  private hashVerifiedCache = new Map<string, { sig: string; hash: string }>();

  // --- toolkit-level ------------------------------------------------------

  list(): Toolkit[] {
    const rows = db()
      .prepare(`
      SELECT id, source, display_name, description, version, installed_path,
             tools_json_hash, content_hash, status, last_error,
             installed_at_ms, updated_at_ms
      FROM toolkits
      ORDER BY display_name COLLATE NOCASE ASC
    `)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToToolkit);
  }

  get(id: string): Toolkit | undefined {
    const row = db()
      .prepare(`
      SELECT id, source, display_name, description, version, installed_path,
             tools_json_hash, content_hash, status, last_error,
             installed_at_ms, updated_at_ms
      FROM toolkits WHERE id = ?
    `)
      .get(id) as Record<string, unknown> | undefined;
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
      db()
        .prepare(`
        UPDATE toolkits
           SET source = ?, display_name = ?, description = ?, version = ?,
               installed_path = ?, tools_json_hash = ?, content_hash = ?,
               status = ?, last_error = NULL, updated_at_ms = ?
         WHERE id = ?
      `)
        .run(
          input.source,
          input.displayName,
          input.description ?? null,
          input.version,
          input.installedPath,
          input.toolsJsonHash,
          input.contentHash,
          input.status ?? "downloaded",
          now,
          input.id,
        );
    } else {
      db()
        .prepare(`
        INSERT INTO toolkits
          (id, source, display_name, description, version, installed_path,
           tools_json_hash, content_hash, status, last_error,
           installed_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `)
        .run(
          input.id,
          input.source,
          input.displayName,
          input.description ?? null,
          input.version,
          input.installedPath,
          input.toolsJsonHash,
          input.contentHash,
          input.status ?? "downloaded",
          now,
          now,
        );
    }
  }

  setStatus(id: string, status: ToolkitStatus): void {
    db()
      .prepare(`UPDATE toolkits SET status = ?, updated_at_ms = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  // Install (deps done): pin the content hash, flip to 'installed', clear any
  // prior error. Invalidates the per-call hash skip-cache so the next verify
  // compares against the freshly pinned hash.
  markInstalled(id: string, contentHash: string): void {
    db()
      .prepare(
        `UPDATE toolkits SET status = 'installed', content_hash = ?, last_error = NULL, updated_at_ms = ? WHERE id = ?`,
      )
      .run(contentHash, Date.now(), id);
    this.hashVerifiedCache.delete(id);
  }

  // Out-of-band content change detected. Flip to 'drift' (keeping the pinned
  // hash for reference) and leave it for the user to confirm. Callers also call
  // disableAllTools(id) so a drifted toolkit can never be LLM-exposed.
  markDrift(id: string): void {
    db()
      .prepare(`UPDATE toolkits SET status = 'drift', updated_at_ms = ? WHERE id = ?`)
      .run(Date.now(), id);
    this.hashVerifiedCache.delete(id);
  }

  // Confirm-reenable: re-pin the CURRENT on-disk content as trusted, clear the
  // drift state + any error, return to 'installed'. The user re-enables tools
  // afterward (they were disabled when drift was flagged).
  repinAndClear(id: string, contentHash: string): void {
    db()
      .prepare(
        `UPDATE toolkits SET status = 'installed', content_hash = ?, last_error = NULL, updated_at_ms = ? WHERE id = ?`,
      )
      .run(contentHash, Date.now(), id);
    this.hashVerifiedCache.delete(id);
  }

  setLastError(id: string, error: string | null): void {
    db()
      .prepare(`UPDATE toolkits SET last_error = ?, updated_at_ms = ? WHERE id = ?`)
      .run(error, Date.now(), id);
  }

  // Boot-time integrity check. Walks every INSTALLED toolkit, recomputes its
  // content hash (per hash.ts: excludes node_modules + deno.lock + .gitignore-
  // listed paths; includes .gitignore itself), and on a mismatch flips the row
  // to status='drift' AND disables all its tools so a tampered toolkit can never
  // be LLM-exposed. A 'downloaded' toolkit has no pinned hash to check; a 'drift'
  // toolkit is already flagged. There is NO auto-clear on match: leaving drift
  // requires the user's explicit confirm-reenable (which re-pins the hash).
  //
  // Returns the IDs that drifted (for boot logging).
  async verifyAllOnBoot(): Promise<string[]> {
    const log = getLogger("toolkits.verify");
    const drifted: string[] = [];
    for (const tk of this.list()) {
      if (tk.status !== "installed") continue;
      let actualHash: string;
      try {
        actualHash = await hashToolkit(tk.installedPath);
      } catch (err) {
        const msg = errMessage(err);
        log.warn(`[${tk.id}] hash failed: ${msg}; flagging drift`);
        this.markDrift(tk.id);
        this.disableAllTools(tk.id);
        this.setLastError(tk.id, `${HASH_FAILED_PREFIX}: ${msg}`);
        drifted.push(tk.id);
        continue;
      }
      if (actualHash !== tk.contentHash) {
        log.warn(
          `[${tk.id}] content drift: stored=${tk.contentHash.slice(
            0,
            12,
          )} actual=${actualHash.slice(0, 12)}; disabling tools`,
        );
        this.markDrift(tk.id);
        this.disableAllTools(tk.id);
        drifted.push(tk.id);
      }
    }
    return drifted;
  }

  // Per-call integrity check: re-verify a toolkit's content hash at tool-call
  // time so a toolkit tampered AFTER boot can't execute (verifyAllOnBoot only
  // runs at startup). Cheap when unchanged via the stat skip-cache. On mismatch
  // (or hash failure) it flips the toolkit to status='drift', disables all its
  // tools, and throws toolkit_hash_drift. There is no auto-clear: re-enabling
  // requires the user's explicit confirm-reenable.
  async verifyHashFresh(toolkitId: string): Promise<void> {
    const tk = this.get(toolkitId);
    if (!tk) return; // unknown toolkit; the tool lookup already handled this
    // Defense in depth: a call should only reach here for an installed toolkit
    // (the chat-exposure gate excludes non-installed). Refuse otherwise.
    if (tk.status !== "installed") {
      throw new AppError(
        "toolkit_hash_drift",
        `toolkit ${toolkitId} is not installed (status ${tk.status})`,
      );
    }
    const sig = await statSignature(tk.installedPath);
    const cached = this.hashVerifiedCache.get(toolkitId);
    if (cached && cached.sig === sig && cached.hash === tk.contentHash) return;
    let actual: string;
    try {
      actual = await hashToolkit(tk.installedPath);
    } catch (err) {
      this.markDrift(toolkitId);
      this.disableAllTools(toolkitId);
      this.setLastError(toolkitId, `${HASH_FAILED_PREFIX}: ${errMessage(err)}`);
      throw new AppError(
        "toolkit_hash_drift",
        `toolkit ${toolkitId} hash failed: ${errMessage(err)}`,
      );
    }
    if (actual === tk.contentHash) {
      this.hashVerifiedCache.set(toolkitId, { sig, hash: actual });
      return;
    }
    this.markDrift(toolkitId);
    this.disableAllTools(toolkitId);
    throw new AppError(
      "toolkit_hash_drift",
      `toolkit ${toolkitId} content changed since it was trusted`,
    );
  }

  delete(id: string): void {
    // CASCADE drops tools, tool_embeddings, grants.
    db().prepare(`DELETE FROM toolkits WHERE id = ?`).run(id);
  }

  // --- tool-level ---------------------------------------------------------

  replaceTools(toolkitId: string, tools: ToolInsertInput[]): void {
    // Atomically replace the toolkit's tools. Across a re-download we preserve
    // each surviving tool's `enabled` flag (by name) so the user's tool
    // selection isn't lost on an update, and we preserve its permission grants
    // ONLY when the required-permission SET is also unchanged. A changed perm
    // set drops the grants so the user must re-review (the tool stays
    // enabled-but-not-exposed until re-granted). Grants would otherwise be lost
    // entirely: the DELETE below cascades them away (grants.tool_id FK), so we
    // snapshot + re-insert. Tool ids are deterministic (`toolkitId::name`), so a
    // re-inserted tool keeps the same id its grants reference.
    const existing = db()
      .prepare(`
      SELECT id, name, enabled, required_permissions_json FROM tools WHERE toolkit_id = ?
    `)
      .all(toolkitId) as Array<{
      id: string;
      name: string;
      enabled: number;
      required_permissions_json: string;
    }>;
    const existingByName = new Map(existing.map((r) => [r.name, r]));
    const grantsByToolId = new Map<string, Grant[]>();
    for (const r of existing) grantsByToolId.set(r.id, this.listGrantsForTool(r.id));

    db().exec("BEGIN");
    try {
      db().prepare(`DELETE FROM tools WHERE toolkit_id = ?`).run(toolkitId);
      for (const t of tools) {
        const id = toolId(toolkitId, t.name);
        const prior = existingByName.get(t.name);
        db()
          .prepare(`
          INSERT INTO tools
            (id, toolkit_id, name, description, parameters_json, triggers_json,
             fn_export, always_available, enabled, required_permissions_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            id,
            toolkitId,
            t.name,
            t.description,
            JSON.stringify(t.parameters),
            JSON.stringify(t.triggers),
            t.fnExport,
            t.alwaysAvailable ? 1 : 0,
            prior ? prior.enabled : 0,
            JSON.stringify(t.requiredPermissions),
          );
        if (
          prior &&
          permKeySet(prior.required_permissions_json) ===
            permKeySet(JSON.stringify(t.requiredPermissions))
        ) {
          for (const g of grantsByToolId.get(prior.id) ?? []) {
            db()
              .prepare(`
              INSERT INTO grants (tool_id, permission_key, permission_kind, state, granted_at_ms)
              VALUES (?, ?, ?, ?, ?)
            `)
              .run(id, g.permissionKey, g.permissionKind, g.state, g.grantedAtMs);
          }
        }
      }
      db().exec("COMMIT");
    } catch (err) {
      db().exec("ROLLBACK");
      throw err;
    }
  }

  listTools(toolkitId: string): Tool[] {
    const rows = db()
      .prepare(`
      SELECT id, toolkit_id, name, description, parameters_json, triggers_json,
             fn_export, always_available, enabled, required_permissions_json
      FROM tools WHERE toolkit_id = ?
      ORDER BY name ASC
    `)
      .all(toolkitId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.attachGrants(rowToTool(r)));
  }

  getTool(toolId: string): Tool | undefined {
    const row = db()
      .prepare(`
      SELECT id, toolkit_id, name, description, parameters_json, triggers_json,
             fn_export, always_available, enabled, required_permissions_json
      FROM tools WHERE id = ?
    `)
      .get(toolId) as Record<string, unknown> | undefined;
    return row ? this.attachGrants(rowToTool(row)) : undefined;
  }

  setToolEnabled(toolkitId: string, name: string, enabled: boolean): void {
    db()
      .prepare(`UPDATE tools SET enabled = ? WHERE toolkit_id = ? AND name = ?`)
      .run(enabled ? 1 : 0, toolkitId, name);
  }

  // Bulk toggles backing the "Enable all / Disable all" toolkit-detail action.
  // Enabling does not grant permissions: a tool with ungranted required perms
  // ends up enabled-but-not-exposed (the chat layer is the final gate).
  enableAllTools(toolkitId: string): void {
    db().prepare(`UPDATE tools SET enabled = 1 WHERE toolkit_id = ?`).run(toolkitId);
  }

  disableAllTools(toolkitId: string): void {
    db().prepare(`UPDATE tools SET enabled = 0 WHERE toolkit_id = ?`).run(toolkitId);
  }

  // --- grants -------------------------------------------------------------

  setGrants(
    toolId: string,
    entries: Array<{ key: string; kind: PermissionDecl["kind"]; state: GrantState }>,
  ): Grant[] {
    const now = Date.now();
    db().exec("BEGIN");
    try {
      for (const entry of entries) {
        db()
          .prepare(`
          INSERT INTO grants (tool_id, permission_key, permission_kind, state, granted_at_ms)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tool_id, permission_key) DO UPDATE SET
            state = excluded.state,
            granted_at_ms = excluded.granted_at_ms
        `)
          .run(toolId, entry.key, entry.kind, entry.state, now);
      }
      db().exec("COMMIT");
    } catch (err) {
      db().exec("ROLLBACK");
      throw err;
    }
    return this.listGrantsForTool(toolId);
  }

  listGrantsForTool(toolId: string): Grant[] {
    const rows = db()
      .prepare(`
      SELECT tool_id, permission_key, permission_kind, state, granted_at_ms
      FROM grants WHERE tool_id = ?
    `)
      .all(toolId) as Array<{
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

  storeEmbedding(toolId: string, vector: Float32Array, sourceHash: string): void {
    db()
      .prepare(`
      INSERT INTO tool_embeddings (tool_id, dim, vector, source_hash)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tool_id) DO UPDATE SET
        dim = excluded.dim,
        vector = excluded.vector,
        source_hash = excluded.source_hash
    `)
      .run(toolId, vector.length, new Uint8Array(vector.buffer.slice(0)), sourceHash);
  }

  loadEmbedding(toolId: string): { vector: Float32Array; sourceHash: string } | undefined {
    const row = db()
      .prepare(`
      SELECT vector, dim, source_hash FROM tool_embeddings WHERE tool_id = ?
    `)
      .get(toolId) as { vector: Uint8Array; dim: number; source_hash: string } | undefined;
    if (!row) return undefined;
    return decodeEmbeddingRow(row);
  }

  // Batch-load every stored tool embedding in a single query. The relevance
  // filter (phase1) runs on every chat turn over all enabled tools; calling
  // loadEmbedding() per tool was N prepared statements + N round-trips. Keyed by
  // tool id; tools without an embedding are simply absent.
  loadAllEmbeddings(): Map<string, { vector: Float32Array; sourceHash: string }> {
    const rows = db()
      .prepare(`SELECT tool_id, vector, dim, source_hash FROM tool_embeddings`)
      .all() as Array<{ tool_id: string; vector: Uint8Array; dim: number; source_hash: string }>;
    const out = new Map<string, { vector: Float32Array; sourceHash: string }>();
    for (const row of rows) out.set(String(row.tool_id), decodeEmbeddingRow(row));
    return out;
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

// Decode a tool_embeddings row's BLOB into a Float32Array view, copying out of
// the SQLite-owned buffer at the right offset.
function decodeEmbeddingRow(row: { vector: Uint8Array; source_hash: string }): {
  vector: Float32Array;
  sourceHash: string;
} {
  const bytes =
    row.vector instanceof Uint8Array ? row.vector : new Uint8Array(row.vector as ArrayBuffer);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { vector: new Float32Array(buf), sourceHash: row.source_hash };
}

export function toolId(toolkitId: string, toolName: string): string {
  return `${toolkitId}::${toolName}`;
}

// Canonical, order-independent signature of a tool's required-permission set
// (by permission key), used by replaceTools to decide whether grants survive a
// re-download. Two perm declarations that produce the same key set are treated
// as unchanged.
function permKeySet(requiredPermissionsJson: string): string {
  try {
    const decls = JSON.parse(requiredPermissionsJson) as PermissionDecl[];
    return decls
      .map((d) => permissionKey(d))
      .sort()
      .join("|");
  } catch {
    return requiredPermissionsJson;
  }
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
    status: String(row.status) as ToolkitStatus,
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
