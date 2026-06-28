// Memory store: reference *knowledge* (a `<slug>.md` file) and procedural
// *skills* (a `<slug>/` folder holding SKILL.md plus optional bundled files)
// under ~/.tomat/<channel>/core/memories/ are the source of truth; SQLite
// (`memories`) carries metadata plus the background-generated summary +
// embedding. `rescan()` reconciles the two by content hash, so memories edited
// or dropped in by hand become first-class on the next scan.
//
// Memories shipped by an extension are read-only and live under that
// extension's install dir; the extension registers its base directory via
// `registerMemoryProvider` so the store can resolve their content. Only
// `USER_MEMORY_PROVIDER` memories are editable, written, or rescanned here.
//
// Synchronous fs (and synchronous hashing) for the same reasons as
// sessions-store.ts: call sites are sync (broker ops, chat prompt assembly),
// and a method that never yields to the event loop can't interleave with
// another caller's read-modify-write.

import { join } from "@std/path";
import {
  type Memory,
  type MemoryKind,
  type MemoryMeta,
  parseSkill,
  USER_MEMORY_PROVIDER,
} from "@tomat/shared";
import { db } from "../db/connection.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { isWithin } from "../shared/fs-safety.ts";
import { sha256HexSync } from "../shared/hash.ts";
import { newMemoryId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("memories");

// The instruction body inside a skill folder. The folder name is the slug.
const SKILL_FILE = "SKILL.md";

// Per-provider base directory. `USER_MEMORY_PROVIDER` resolves lazily to the
// core memories dir; extensions register theirs at load time.
const providerBaseDirs = new Map<string, string>();

/** Register where an extension's read-only memories live, so the store can
 *  resolve their content. Idempotent. */
export function registerMemoryProvider(provider: string, baseDir: string): void {
  providerBaseDirs.set(provider, baseDir);
}

function baseDirFor(provider: string): string {
  if (provider === USER_MEMORY_PROVIDER) return paths().memoriesDir;
  const dir = providerBaseDirs.get(provider);
  if (!dir) {
    throw new AppError("not_found", `memory provider "${provider}" is not registered`);
  }
  return dir;
}

export class MemoriesStore {
  list(): MemoryMeta[] {
    const rows = db()
      .prepare(`${META_SELECT} ORDER BY title COLLATE NOCASE ASC`)
      .all() as MetaRow[];
    return rows.map(rowToMeta);
  }

  get(id: string): Memory {
    const meta = this.metaOrThrow(id);
    return { ...meta, content: readContent(meta), files: skillFiles(meta) };
  }

  // Case-insensitive lookup: titles are unique COLLATE NOCASE (see create),
  // and tools address memories by the title they saw in the prompt, which
  // the model may re-case.
  getByTitle(title: string): Memory | undefined {
    const row = db().prepare(`${META_SELECT} WHERE title = ? COLLATE NOCASE`).get(title) as
      | MetaRow
      | undefined;
    if (!row) return undefined;
    const meta = rowToMeta(row);
    return { ...meta, content: readContent(meta), files: skillFiles(meta) };
  }

  /** Read one bundled reference file from a skill folder. Guards against path
   *  traversal: `name` must be a plain file directly inside the folder. */
  getFile(id: string, name: string): string {
    const path = this.skillFilePath(this.metaOrThrow(id), name);
    try {
      return Deno.readTextFileSync(path);
    } catch {
      throw new AppError("not_found", `skill file "${name}" not found`);
    }
  }

  /** Create or replace a bundled reference file beside a user skill's SKILL.md.
   *  Extension skills are read-only; the same traversal guard as getFile
   *  applies. Bumps the memory's updated_at so the card reflects the edit. */
  writeFile(id: string, name: string, content: string): void {
    const path = this.skillFilePath(this.editableOrThrow(id), name);
    const tmp = path + ".tmp";
    Deno.writeTextFileSync(tmp, content);
    Deno.renameSync(tmp, path);
    this.touch(id);
  }

  /** Delete a bundled reference file from a user skill's folder. */
  deleteFile(id: string, name: string): void {
    const path = this.skillFilePath(this.editableOrThrow(id), name);
    try {
      Deno.removeSync(path);
    } catch {
      throw new AppError("not_found", `skill file "${name}" not found`);
    }
    this.touch(id);
  }

  /** Path of a bundled file inside a skill folder, with the traversal guard
   *  shared by getFile/writeFile/deleteFile. SKILL.md itself is off-limits:
   *  it is the memory's content, edited through replaceContent. */
  private skillFilePath(meta: MemoryMeta, name: string): string {
    if (meta.kind !== "skill") {
      throw new AppError("validation_error", "memory is not a skill");
    }
    // SKILL.md is rejected case-insensitively: on a case-insensitive filesystem
    // a "skill.md" bundled file would otherwise resolve to and overwrite the
    // instruction body, which is edited through replaceContent, not here.
    if (
      name.trim() === "" ||
      name.toLowerCase() === SKILL_FILE.toLowerCase() ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("..")
    ) {
      throw new AppError("validation_error", `invalid skill file "${name}"`);
    }
    return join(baseDirFor(meta.provider), meta.filename, name);
  }

  create(kind: MemoryKind, title: string, content: string): Memory {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      throw new AppError("validation_error", "memory title required");
    }
    // NOCASE: "Notes" next to "notes" would be two rows tools can't tell
    // apart through the title-keyed API.
    if (this.titleExists(cleanTitle)) {
      throw new AppError("conflict", `memory "${cleanTitle}" already exists`);
    }
    const id = newMemoryId();
    const filename = uniqueName(kind, cleanTitle);
    const hash = sha256HexSync(content);
    const now = Date.now();
    const skill = kind === "skill" ? parseSkillMeta(content) : null;
    // Write the file BEFORE the row so a failed write can never leave a row
    // pointing at missing content. rescan() tolerates orphans, so if the INSERT
    // then fails we remove what we wrote (best-effort).
    writeUserContent(kind, filename, content);
    try {
      db()
        .prepare(`
        INSERT INTO memories (id, kind, title, filename, content_hash, summary, summary_source_hash,
                              provider, enabled, suggested_tools, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `)
        .run(
          id,
          kind,
          cleanTitle,
          filename,
          hash,
          skill?.description ?? null,
          skill?.description ? hash : null,
          USER_MEMORY_PROVIDER,
          skill && skill.suggestedTools.length ? JSON.stringify(skill.suggestedTools) : null,
          now,
          now,
        );
    } catch (err) {
      removeUserContent(kind, filename);
      throw err;
    }
    return this.get(id);
  }

  replaceContent(id: string, content: string): Memory {
    const meta = this.editableOrThrow(id);
    const hash = sha256HexSync(content);
    const skill = meta.kind === "skill" ? parseSkillMeta(content) : null;
    db()
      .prepare(
        `UPDATE memories SET content_hash = ?, suggested_tools = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(
        hash,
        skill && skill.suggestedTools.length ? JSON.stringify(skill.suggestedTools) : null,
        Date.now(),
        id,
      );
    writeUserContent(meta.kind, meta.filename, content);
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
  ): { memory: Memory; before: string; after: string } {
    if (find.length === 0) {
      throw new AppError("validation_error", "find text must not be empty");
    }
    const meta = this.editableOrThrow(id);
    const before = readContent(meta);
    const first = before.indexOf(find);
    if (first === -1) {
      throw new AppError("validation_error", "find text not found in memory");
    }
    if (before.indexOf(find, first + 1) !== -1) {
      throw new AppError(
        "validation_error",
        "find text matches more than once; include more surrounding context",
      );
    }
    const after = before.slice(0, first) + replace + before.slice(first + find.length);
    const memory = this.replaceContent(id, after);
    return { memory, before, after };
  }

  rename(id: string, title: string): MemoryMeta {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      throw new AppError("validation_error", "memory title required");
    }
    const meta = this.editableOrThrow(id);
    if (cleanTitle === meta.title) return meta;
    if (this.titleExists(cleanTitle, id)) {
      throw new AppError("conflict", `memory "${cleanTitle}" already exists`);
    }
    // The on-disk name keeps stable: names only need to be unique, and a rename
    // that also moved files would break external references for no gain.
    db()
      .prepare(`UPDATE memories SET title = ?, updated_at_ms = ? WHERE id = ?`)
      .run(cleanTitle, Date.now(), id);
    return this.metaOrThrow(id);
  }

  /** Toggle whether a memory participates in chat. Allowed for any provider:
   *  the user may silence an extension's memory without uninstalling it. */
  setEnabled(id: string, enabled: boolean): MemoryMeta {
    this.metaOrThrow(id);
    db()
      .prepare(`UPDATE memories SET enabled = ?, updated_at_ms = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, Date.now(), id);
    return this.metaOrThrow(id);
  }

  delete(id: string): void {
    const meta = this.editableOrThrow(id);
    db().prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    removeUserContent(meta.kind, meta.filename);
  }

  /** Reconcile user rows with the files/folders on disk. New `<slug>.md` files
   *  become knowledge and new `<slug>/SKILL.md` folders become skills (title
   *  from the slug); rows whose content vanished are dropped; rows whose body
   *  drifted get their hash bumped so the indexer refreshes. Extension-provided
   *  memories are reconciled at extension load, not here. */
  rescan(): { added: number; removed: number; changed: number } {
    const dir = paths().memoriesDir;
    // filename -> { kind, content }
    const onDisk = new Map<string, { kind: MemoryKind; content: string }>();
    for (const entry of Deno.readDirSync(dir)) {
      try {
        if (entry.isFile && entry.name.endsWith(".md")) {
          onDisk.set(entry.name, {
            kind: "knowledge",
            content: readPath(join(dir, entry.name)),
          });
        } else if (entry.isDirectory) {
          const body = join(dir, entry.name, SKILL_FILE);
          onDisk.set(entry.name, { kind: "skill", content: readPath(body) });
        }
      } catch {
        // Vanished or has no SKILL.md; the next rescan settles it.
      }
    }
    let added = 0;
    let removed = 0;
    let changed = 0;
    const now = Date.now();
    db().exec("BEGIN");
    try {
      for (const row of this.list()) {
        if (row.provider !== USER_MEMORY_PROVIDER) continue;
        const disk = onDisk.get(row.filename);
        if (disk === undefined || disk.kind !== row.kind) {
          db().prepare(`DELETE FROM memories WHERE id = ?`).run(row.id);
          removed++;
          continue;
        }
        onDisk.delete(row.filename);
        const hash = sha256HexSync(disk.content);
        if (hash !== row.contentHash) {
          const skill = row.kind === "skill" ? parseSkillMeta(disk.content) : null;
          db()
            .prepare(
              `UPDATE memories SET content_hash = ?, suggested_tools = ?, updated_at_ms = ? WHERE id = ?`,
            )
            .run(
              hash,
              skill && skill.suggestedTools.length ? JSON.stringify(skill.suggestedTools) : null,
              now,
              row.id,
            );
          changed++;
        }
      }
      for (const [filename, disk] of onDisk) {
        const stem = filename.replace(/\.md$/, "");
        const title = uniqueTitle(stem);
        const skill = disk.kind === "skill" ? parseSkillMeta(disk.content) : null;
        const hash = sha256HexSync(disk.content);
        db()
          .prepare(`
          INSERT INTO memories (id, kind, title, filename, content_hash, summary, summary_source_hash,
                                provider, enabled, suggested_tools, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `)
          .run(
            newMemoryId(),
            disk.kind,
            title,
            filename,
            hash,
            skill?.description ?? null,
            skill?.description ? hash : null,
            USER_MEMORY_PROVIDER,
            skill && skill.suggestedTools.length ? JSON.stringify(skill.suggestedTools) : null,
            now,
            now,
          );
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

  /** Reconcile the read-only memories an extension ships (from its tomat.json
   *  `memories` array). The extension's base dir is registered so content
   *  resolves; one row per declared memory is upserted (provider = extensionId,
   *  disabled by default per the opt-in rule). Declarations that vanished are
   *  removed. `extensionsBaseDir` is the parent of the install dir, so a row's
   *  `filename` (`${extensionId}/${decl.path}`) stays globally unique while
   *  resolving to `<installDir>/<decl.path>`. */
  registerExtensionMemories(
    extensionId: string,
    extensionsBaseDir: string,
    decls: Array<{ kind: MemoryKind; path: string }>,
  ): void {
    registerMemoryProvider(extensionId, extensionsBaseDir);
    const now = Date.now();
    // Defense in depth: the manifest schema already rejects `..`/absolute paths,
    // but re-check containment here before any path reaches the filesystem, so a
    // declared memory can never resolve outside the extension's install dir.
    const installDir = join(extensionsBaseDir, extensionId);
    const safe = decls.filter((d) => {
      if (isWithin(installDir, join(installDir, d.path))) return true;
      log.warn(`extension "${extensionId}" memory path escapes install dir; skipped: ${d.path}`);
      return false;
    });
    const want = new Map(safe.map((d) => [`${extensionId}/${d.path}`, d]));
    db().exec("BEGIN");
    try {
      for (const row of this.list()) {
        if (row.provider !== extensionId) continue;
        if (!want.has(row.filename)) {
          db().prepare(`DELETE FROM memories WHERE id = ?`).run(row.id);
        } else {
          want.delete(row.filename); // already present; leave as-is
        }
      }
      for (const [filename, d] of want) {
        const probe = {
          kind: d.kind,
          filename,
          provider: extensionId,
        } as MemoryMeta;
        let content: string;
        try {
          content = readContent(probe);
        } catch {
          continue; // declared path missing on disk; skip rather than fail install
        }
        const hash = sha256HexSync(content);
        const skill = d.kind === "skill" ? parseSkillMeta(content) : null;
        const title = uniqueTitle(prettyTitle(d.path));
        db()
          .prepare(`
          INSERT INTO memories (id, kind, title, filename, content_hash, summary, summary_source_hash,
                                provider, enabled, suggested_tools, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `)
          .run(
            newMemoryId(),
            d.kind,
            title,
            filename,
            hash,
            skill?.description ?? null,
            skill?.description ? hash : null,
            extensionId,
            skill && skill.suggestedTools.length ? JSON.stringify(skill.suggestedTools) : null,
            now,
            now,
          );
      }
      db().exec("COMMIT");
    } catch (err) {
      db().exec("ROLLBACK");
      throw err;
    }
  }

  /** Drop every memory an extension provided (called when it is removed). */
  removeExtensionMemories(extensionId: string): void {
    db().prepare(`DELETE FROM memories WHERE provider = ?`).run(extensionId);
  }

  // --- index bookkeeping (used by the background indexer) ------------------

  setSummary(id: string, summary: string, sourceHash: string): void {
    db()
      .prepare(`UPDATE memories SET summary = ?, summary_source_hash = ? WHERE id = ?`)
      .run(summary, sourceHash, id);
  }

  setEmbedding(id: string, vector: Float32Array, sourceHash: string): void {
    db()
      .prepare(`
      UPDATE memories
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
      SELECT id, content_hash, summary_source_hash, embedding_source_hash FROM memories
    `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      contentHash: String(r.content_hash),
      summarySourceHash: r.summary_source_hash == null ? null : String(r.summary_source_hash),
      embeddingSourceHash: r.embedding_source_hash == null ? null : String(r.embedding_source_hash),
    }));
  }

  /** All memory embeddings, for relevance scoring at prompt time. */
  loadAllEmbeddings(): Map<string, Float32Array> {
    const rows = db()
      .prepare(`SELECT id, embedding, embedding_dim FROM memories WHERE embedding IS NOT NULL`)
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

  private metaOrThrow(id: string): MemoryMeta {
    const row = db().prepare(`${META_SELECT} WHERE id = ?`).get(id) as MetaRow | undefined;
    if (!row) throw new AppError("not_found", `memory ${id} not found`);
    return rowToMeta(row);
  }

  /** Like metaOrThrow, but rejects extension-provided (read-only) memories. */
  private editableOrThrow(id: string): MemoryMeta {
    const meta = this.metaOrThrow(id);
    if (meta.provider !== USER_MEMORY_PROVIDER) {
      throw new AppError("conflict", `memory ${id} is provided by an extension and is read-only`);
    }
    return meta;
  }

  private touch(id: string): void {
    db().prepare(`UPDATE memories SET updated_at_ms = ? WHERE id = ?`).run(Date.now(), id);
  }

  private titleExists(title: string, excludeId?: string): boolean {
    const row = db()
      .prepare(`SELECT id FROM memories WHERE title = ? COLLATE NOCASE`)
      .get(title) as { id: string } | undefined;
    return row !== undefined && row.id !== excludeId;
  }
}

let _instance: MemoriesStore | null = null;
export function memoriesStore(): MemoriesStore {
  if (!_instance) _instance = new MemoriesStore();
  return _instance;
}

// Test-only: drops the cached instance.
export function __resetForTesting(): void {
  _instance = null;
  providerBaseDirs.clear();
}

// --- helpers ----------------------------------------------------------------

const META_SELECT = `
  SELECT id, kind, title, filename, content_hash, summary, summary_source_hash, provider, enabled,
         suggested_tools, created_at_ms, updated_at_ms
  FROM memories`;

interface MetaRow {
  id: string;
  kind: string;
  title: string;
  filename: string;
  content_hash: string;
  summary: string | null;
  summary_source_hash: string | null;
  provider: string;
  enabled: number;
  suggested_tools: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function rowToMeta(row: MetaRow): MemoryMeta {
  const kind = row.kind === "skill" ? "skill" : "knowledge";
  let suggestedTools: string[] | undefined;
  if (row.suggested_tools) {
    try {
      const parsed = JSON.parse(row.suggested_tools);
      if (Array.isArray(parsed)) suggestedTools = parsed.map(String);
    } catch {
      /* ignore malformed cache */
    }
  }
  return {
    id: String(row.id),
    kind,
    title: String(row.title),
    filename: String(row.filename),
    contentHash: String(row.content_hash),
    summary: row.summary == null ? undefined : String(row.summary),
    // Stale when never indexed or edited since: the pinned summary source hash
    // differs from the current content hash.
    summaryStale:
      row.summary_source_hash == null ||
      String(row.summary_source_hash) !== String(row.content_hash),
    provider: String(row.provider),
    enabled: Number(row.enabled) !== 0,
    suggestedTools: kind === "skill" ? suggestedTools : undefined,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function readPath(path: string): string {
  return Deno.readTextFileSync(path);
}

function readContent(meta: MemoryMeta): string {
  const base = baseDirFor(meta.provider);
  const path =
    meta.kind === "skill" ? join(base, meta.filename, SKILL_FILE) : join(base, meta.filename);
  try {
    return readPath(path);
  } catch {
    // Row exists but the content vanished. Surfacing the loss beats returning
    // "" and letting a tool "read" or overwrite an empty memory it believes is
    // real.
    throw new AppError(
      "not_found",
      `memory content for "${meta.filename}" is missing on disk; run a memories rescan`,
    );
  }
}

/** Bundled reference file names beside a skill's SKILL.md, or undefined for
 *  knowledge. Best-effort: an unreadable folder yields an empty list. */
function skillFiles(meta: MemoryMeta): string[] | undefined {
  if (meta.kind !== "skill") return undefined;
  const out: string[] = [];
  try {
    for (const entry of Deno.readDirSync(join(baseDirFor(meta.provider), meta.filename))) {
      if (entry.isFile && entry.name !== SKILL_FILE) out.push(entry.name);
    }
  } catch {
    /* folder gone; rescan settles it */
  }
  return out.sort();
}

// Atomic write (tmp + rename), mirroring sessions-store.writeDoc. Skills write
// their SKILL.md inside the (created-if-needed) folder.
function writeUserContent(kind: MemoryKind, filename: string, content: string): void {
  const dir = paths().memoriesDir;
  const path = kind === "skill" ? join(dir, filename, SKILL_FILE) : join(dir, filename);
  if (kind === "skill") {
    Deno.mkdirSync(join(dir, filename), { recursive: true });
  }
  const tmp = path + ".tmp";
  Deno.writeTextFileSync(tmp, content);
  Deno.renameSync(tmp, path);
}

function removeUserContent(kind: MemoryKind, filename: string): void {
  try {
    Deno.removeSync(join(paths().memoriesDir, filename), {
      recursive: kind === "skill",
    });
  } catch {
    /* already gone; rescan would otherwise re-adopt an orphan */
  }
}

// The summary source (`description`) and advisory `suggested-tools` are read
// from the skill's SKILL.md frontmatter. The format (and its tolerance of other
// keys, so a community SKILL.md drops in unchanged) lives in the shared
// `parseSkill`; here we only need the two metadata fields, with an absent
// description normalized to undefined so the indexer summarizes instead.
function parseSkillMeta(content: string): { suggestedTools: string[]; description?: string } {
  const { description, suggestedTools } = parseSkill(content);
  return { suggestedTools, description: description || undefined };
}

// "Meeting Notes: Q3!" -> "meeting-notes-q3" (skill folder) or
// "meeting-notes-q3.md" (knowledge file), suffixed -2, -3, ... until it
// collides with neither a DB row nor a stray entry on disk.
function uniqueName(kind: MemoryKind, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "memory";
  for (let i = 1; ; i++) {
    const stem = i === 1 ? slug : `${slug}-${i}`;
    const name = kind === "skill" ? stem : `${stem}.md`;
    const inDb = db().prepare(`SELECT 1 FROM memories WHERE filename = ?`).get(name);
    if (inDb) continue;
    try {
      Deno.statSync(join(paths().memoriesDir, name));
    } catch {
      return name; // not on disk either
    }
  }
}

// "skills/file-bug" or "knowledge/release-notes.md" -> "File Bug" /
// "Release Notes": last path segment, separators to spaces, title-cased.
function prettyTitle(path: string): string {
  const last = path.replace(/\/+$/, "").split("/").pop() ?? path;
  const words = last
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || "Memory";
}

// Title for a rescanned entry, de-duplicated against existing rows the same
// way names are.
function uniqueTitle(stem: string): string {
  const base = stem.trim() || "Memory";
  for (let i = 1; ; i++) {
    const title = i === 1 ? base : `${base} (${i})`;
    const exists = db().prepare(`SELECT 1 FROM memories WHERE title = ? COLLATE NOCASE`).get(title);
    if (!exists) return title;
  }
}
