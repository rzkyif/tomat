// Sessions / messages / attachments store, backed by plain JSON files on disk
// (one dir per session under ~/.tomat/<channel>/core/sessions/), the way the
// old tomat Client stored them. Each session is a single `session.json`
// holding its metadata, messages, and attachment records; attachment bytes live
// next to it under `attachments/` (written by the HTTP route, recorded here).
//
// The store is intentionally SYNCHRONOUS (Deno `*Sync` fs APIs). Two reasons:
//   1. The 35 call sites across chat.ts / title-gen.ts / the sessions route
//      call it synchronously, so the interface stays unchanged.
//   2. A synchronous JS method never yields, so a read-modify-write of one
//      `session.json` can't interleave with another caller's. That gives us
//      lost-update safety for free, with no mutex. Writes are atomic
//      (tmp file + rename), mirroring core-settings.writeAtomic.
//
// Owner-scoping mirrors the old SQL WHERE owner_client_id clauses: a wrong
// owner surfaces as session_not_found, so cross-client access is impossible.

import {
  contentToText,
  type Message,
  type MessageContent,
  type Session,
  type SessionListEntry,
  type SummaryPart,
} from "@tomat/shared";
import { join } from "@std/path";
import { paths, sessionAttachmentsDir, sessionDir } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { newAttachmentId, newMessageId, newSessionId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("sessions-store");

export interface CreateSessionInput {
  ownerClientId: string;
  title?: string;
  /** Create a temporary (RAM-only) session: it lives in the in-memory
   *  `ephemeral` map below, never touches disk, and is excluded from every
   *  listing. Fixed at creation; there is no later reclassification. */
  temporary?: boolean;
}

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  messageId: string;
  filename: string;
  mime?: string;
  sizeBytes: number;
  absPath: string;
  createdAtMs: number;
}

// The full document for one session. Persistent sessions are written to
// `session.json`; temporary ones (`temporary: true`) live only in the
// `ephemeral` map and are never serialized.
interface SessionDoc {
  id: string;
  ownerClientId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokenUsage?: Session["tokenUsage"];
  temporary?: boolean;
  messages: Message[];
  attachments: AttachmentRecord[];
}

// Temporary sessions, keyed by id. They never reach disk: `readDoc` checks
// here first, `writeDoc` keeps a doc that is already here in memory, and
// `removeSessionDir` drops it. `readAllDocs` only walks disk, so listings
// (the session bar list, the Settings storage view) exclude them for free.
// The map is process-lifetime: a core restart wipes every temporary session.
const ephemeral = new Map<string, SessionDoc>();

export class SessionsRepo {
  // --- sessions ------------------------------------------------------------

  create(input: CreateSessionInput): Session {
    const id = newSessionId();
    const now = Date.now();
    const doc: SessionDoc = {
      id,
      ownerClientId: input.ownerClientId,
      title: input.title ?? "",
      createdAtMs: now,
      updatedAtMs: now,
      messages: [],
      attachments: [],
    };
    if (input.temporary) {
      // Born in the map, never on disk. Mark the id first so the writeDoc
      // below routes to memory instead of touching the filesystem.
      doc.temporary = true;
      ephemeral.set(id, doc);
    } else {
      writeDoc(doc);
    }
    return toSession(doc);
  }

  list(ownerClientId: string): SessionListEntry[] {
    const docs = readAllDocs().filter((d) => d.ownerClientId === ownerClientId);
    docs.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      createdAtMs: d.createdAtMs,
      updatedAtMs: d.updatedAtMs,
      messageCount: d.messages.length,
      summary: summarizeConversation(d.messages),
    }));
  }

  getOrThrow(ownerClientId: string, sessionId: string): Session {
    return toSession(this.requireOwned(ownerClientId, sessionId));
  }

  patchTitle(ownerClientId: string, sessionId: string, title: string): void {
    const doc = this.requireOwned(ownerClientId, sessionId);
    doc.title = title;
    doc.updatedAtMs = Date.now();
    writeDoc(doc);
  }

  setTokenUsage(sessionId: string, tokenUsage: Session["tokenUsage"]): void {
    // Owner-agnostic, like the old UPDATE; a missing session is a silent no-op.
    const doc = readDoc(sessionId);
    if (!doc) return;
    doc.tokenUsage = tokenUsage;
    doc.updatedAtMs = Date.now();
    writeDoc(doc);
  }

  delete(ownerClientId: string, sessionId: string): { attachmentPaths: string[] } {
    const doc = this.requireOwned(ownerClientId, sessionId);
    const attachmentPaths = doc.attachments.map((a) => a.absPath);
    removeSessionDir(sessionId);
    return { attachmentPaths };
  }

  /** Drop every temporary session this client owns except `keepId`. A client
   *  has at most one reachable temporary session (they are never listed, so
   *  there is no way back to an older one), so any other temporary session it
   *  owns was orphaned by navigating away without a clean delete (a crash or a
   *  dropped request). Calling this on each navigation / creation reclaims the
   *  RAM (and any on-disk attachment bytes) promptly instead of waiting for a
   *  core restart. `removeSessionDir` recurses, so attachment files go too. */
  sweepClientTemporary(ownerClientId: string, keepId?: string): void {
    const stale = [...ephemeral.values()]
      .filter((d) => d.ownerClientId === ownerClientId && d.id !== keepId)
      .map((d) => d.id);
    for (const id of stale) removeSessionDir(id);
  }

  // --- messages ------------------------------------------------------------

  listMessages(sessionId: string): Message[] {
    return readDoc(sessionId)?.messages ?? [];
  }

  appendMessage(sessionId: string, message: Message): { id: string; ord: number } {
    const doc = this.requireExists(sessionId);
    const id = message.id || newMessageId();
    const ord = nextOrd(doc.messages);
    const stored: Message = {
      ...message,
      id,
      ord,
      createdAtMs: message.createdAtMs || Date.now(),
    } as Message;
    doc.messages.push(stored);
    doc.updatedAtMs = Date.now();
    writeDoc(doc);
    return { id, ord };
  }

  /** Insert a message directly after `afterId` in chronological order, so a
   *  regenerated mid-history turn lands in its slot instead of at the tail.
   *  `afterId: null` (or an id that no longer exists) appends at the tail.
   *  `ord` is renumbered to the array index across the whole doc on every
   *  insert; nothing outside this store relies on specific ord values. */
  insertMessageAfter(
    sessionId: string,
    message: Message,
    afterId: string | null,
  ): { id: string; ord: number } {
    const doc = this.requireExists(sessionId);
    const id = message.id || newMessageId();
    const stored: Message = {
      ...message,
      id,
      createdAtMs: message.createdAtMs || Date.now(),
    } as Message;
    const anchorIdx = afterId === null ? -1 : doc.messages.findIndex((m) => m.id === afterId);
    if (anchorIdx === -1) doc.messages.push(stored);
    else doc.messages.splice(anchorIdx + 1, 0, stored);
    doc.messages.forEach((m, i) => {
      m.ord = i;
    });
    doc.updatedAtMs = Date.now();
    writeDoc(doc);
    return { id, ord: stored.ord };
  }

  /** Remove every message strictly between the anchor and the next-newer
   *  `role: "user"` message (i.e. the old contents of the anchor's turn).
   *  Returns the removed ids so the caller can broadcast deletions. Unknown
   *  anchor = no-op. */
  deleteTurn(sessionId: string, anchorMessageId: string): string[] {
    const doc = this.requireExists(sessionId);
    const anchorIdx = doc.messages.findIndex((m) => m.id === anchorMessageId);
    if (anchorIdx === -1) return [];
    let end = anchorIdx + 1;
    while (end < doc.messages.length && doc.messages[end].role !== "user") {
      end++;
    }
    if (end === anchorIdx + 1) return [];
    const removed = doc.messages.splice(anchorIdx + 1, end - anchorIdx - 1);
    doc.messages.forEach((m, i) => {
      m.ord = i;
    });
    doc.updatedAtMs = Date.now();
    writeDoc(doc);
    return removed.map((m) => m.id);
  }

  getMessage(sessionId: string, messageId: string): Message {
    const doc = this.requireExists(sessionId);
    const msg = doc.messages.find((m) => m.id === messageId);
    if (!msg) {
      throw new AppError("message_not_found", `message ${messageId} not found`);
    }
    return msg;
  }

  patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Message>,
  ): { id: string; ord: number } {
    const doc = this.requireExists(sessionId);
    const idx = doc.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      throw new AppError("message_not_found", `message ${messageId} not found`);
    }
    const current = doc.messages[idx];
    // Pin id / role / ord: a content patch can never re-key, re-role, or
    // reorder a message (ord was a separate, unpatchable DB column before).
    const merged = {
      ...current,
      ...patch,
      id: current.id,
      role: current.role,
      ord: current.ord,
    } as Message;
    doc.messages[idx] = merged;
    doc.updatedAtMs = Date.now();
    writeDoc(doc);
    return { id: current.id, ord: current.ord };
  }

  deleteMessage(sessionId: string, messageId: string): void {
    const doc = this.requireExists(sessionId);
    const idx = doc.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      throw new AppError("message_not_found", "message not found");
    }
    doc.messages.splice(idx, 1);
    doc.updatedAtMs = Date.now();
    writeDoc(doc);
  }

  // --- attachments ---------------------------------------------------------

  recordAttachment(
    sessionId: string,
    messageId: string,
    filename: string,
    mime: string | undefined,
    sizeBytes: number,
    absPath: string,
  ): AttachmentRecord {
    const doc = this.requireExists(sessionId);
    const record: AttachmentRecord = {
      id: newAttachmentId(),
      sessionId,
      messageId,
      filename,
      mime,
      sizeBytes,
      absPath,
      createdAtMs: Date.now(),
    };
    doc.attachments.push(record);
    // Note: no updatedAtMs bump here, matching the old repo.
    writeDoc(doc);
    return record;
  }

  getAttachment(sessionId: string, attachmentId: string): AttachmentRecord {
    const doc = readDoc(sessionId);
    const att = doc?.attachments.find((a) => a.id === attachmentId);
    if (!att) throw new AppError("not_found", "attachment not found");
    return att;
  }

  // --- storage view (all clients) ------------------------------------------

  /** Every session across all clients with its on-disk footprint. Used by the
   *  Settings → Storage view, which spans clients (the per-client `list` is for
   *  the session bar). */
  listAll(): Array<{
    id: string;
    ownerClientId: string;
    title: string;
    updatedAtMs: number;
    sizeBytes: number;
  }> {
    return readAllDocs().map((d) => ({
      id: d.id,
      ownerClientId: d.ownerClientId,
      title: d.title,
      updatedAtMs: d.updatedAtMs,
      sizeBytes: statSize(sessionFile(d.id)) + dirSize(sessionAttachmentsDir(d.id)),
    }));
  }

  /** Delete a session without knowing its owner (admin / storage-view path).
   *  Returns null if it doesn't exist. */
  deleteById(sessionId: string): { ownerClientId: string; attachmentPaths: string[] } | null {
    const doc = readDoc(sessionId);
    if (!doc) return null;
    const attachmentPaths = doc.attachments.map((a) => a.absPath);
    removeSessionDir(sessionId);
    return { ownerClientId: doc.ownerClientId, attachmentPaths };
  }

  // --- helpers -------------------------------------------------------------

  private requireOwned(ownerClientId: string, sessionId: string): SessionDoc {
    const doc = readDoc(sessionId);
    if (!doc || doc.ownerClientId !== ownerClientId) {
      throw new AppError("session_not_found", `session ${sessionId} not found`);
    }
    return doc;
  }

  private requireExists(sessionId: string): SessionDoc {
    const doc = readDoc(sessionId);
    if (!doc) {
      throw new AppError("session_not_found", `session ${sessionId} not found`);
    }
    return doc;
  }
}

let _instance: SessionsRepo | null = null;
export function sessionsRepo(): SessionsRepo {
  if (!_instance) _instance = new SessionsRepo();
  return _instance;
}

// Test-only: drops the cached instance and clears the in-memory temporary
// sessions, so each test starts from a clean slate (disk is otherwise the
// source of truth).
export function __resetForTesting(): void {
  _instance = null;
  ephemeral.clear();
}

/** Remove any session directory that has no readable `session.json`. The only
 *  way such a directory exists is a temporary session whose attachments were
 *  written to disk (by the attachments route) but whose doc lived only in RAM
 *  and so was lost on an unclean shutdown. A persistent session always writes
 *  `session.json` at creation, before any attachment, so this never touches a
 *  real session. Run once at core boot. */
export function sweepOrphanedSessionDirs(): void {
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(paths().sessionsDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  for (const e of entries) {
    if (!e.isDirectory) continue;
    // Existence, not parseability: a corrupt-but-present session.json is a real
    // session readDoc skips, not an orphan to delete.
    if (fileExists(sessionFile(e.name))) continue;
    try {
      Deno.removeSync(sessionDir(e.name), { recursive: true });
      log.info(`swept orphaned session dir ${e.name} (no session.json)`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        log.warn(`failed to sweep orphaned session dir ${e.name}: ${err}`);
      }
    }
  }
}

// --- on-disk helpers -------------------------------------------------------

function sessionFile(id: string): string {
  return join(sessionDir(id), "session.json");
}

function toSession(doc: SessionDoc): Session {
  return {
    id: doc.id,
    ownerClientId: doc.ownerClientId,
    title: doc.title,
    createdAtMs: doc.createdAtMs,
    updatedAtMs: doc.updatedAtMs,
    tokenUsage: doc.tokenUsage,
    temporary: doc.temporary,
  };
}

function readDoc(id: string): SessionDoc | null {
  const mem = ephemeral.get(id);
  // Clone so a temporary session reads exactly like a persistent one: every
  // readDoc hands back a private snapshot, and the map entry only changes
  // through writeDoc. Returning the live object instead would let an in-place
  // mutation (harmless on the disk path's throwaway parse) silently corrupt
  // the canonical state.
  if (mem) return structuredClone(mem);
  let text: string;
  try {
    text = Deno.readTextFileSync(sessionFile(id));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  let parsed: SessionDoc;
  try {
    parsed = JSON.parse(text) as SessionDoc;
  } catch (err) {
    // A truncated / corrupt file must not poison list() / listAll() / GC for
    // every other session: treat it as absent (skipped) rather than throwing.
    log.warn(
      `corrupt session.json for ${id}; skipping: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
  // Defensive defaults so an older / partial file still loads.
  parsed.messages ??= [];
  parsed.attachments ??= [];
  return parsed;
}

function writeDoc(doc: SessionDoc): void {
  // A temporary session lives only in the map: commit the (snapshot) doc the
  // caller mutated, mirroring how the disk path commits via tmp+rename, and
  // short-circuit before any filesystem access.
  if (ephemeral.has(doc.id)) {
    ephemeral.set(doc.id, doc);
    return;
  }
  Deno.mkdirSync(sessionDir(doc.id), { recursive: true });
  const file = sessionFile(doc.id);
  const tmp = file + ".tmp";
  Deno.writeTextFileSync(tmp, JSON.stringify(doc, null, 2));
  Deno.renameSync(tmp, file);
}

function readAllDocs(): SessionDoc[] {
  const out: SessionDoc[] = [];
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(paths().sessionsDir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return out;
    throw err;
  }
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const doc = readDoc(e.name);
    if (doc) out.push(doc);
  }
  return out;
}

function removeSessionDir(id: string): void {
  ephemeral.delete(id);
  try {
    Deno.removeSync(sessionDir(id), { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

function nextOrd(messages: Message[]): number {
  let max = -1;
  for (const m of messages) if (m.ord > max) max = m.ord;
  return max + 1;
}

function statSize(path: string): number {
  try {
    return Deno.statSync(path).size;
  } catch {
    return 0;
  }
}

function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function dirSize(path: string): number {
  let total = 0;
  let entries: Iterable<Deno.DirEntry>;
  try {
    entries = Deno.readDirSync(path);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = join(path, e.name);
    if (e.isDirectory) total += dirSize(full);
    else total += statSize(full);
  }
  return total;
}

const SUMMARY_MAX_CHARS = 160;
const SUMMARY_SNIPPET_MAX_CHARS = 60;

/** Conversation snippets for the session list: the opening user/assistant
 *  exchange, as many turns as fit the budget (the UI truncates to one line
 *  anyway). Labels are left to the client, which knows the configured agent
 *  name. Empty when the session has no user or assistant messages yet. */
function summarizeConversation(messages: Message[]): SummaryPart[] {
  const parts: SummaryPart[] = [];
  let total = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = contentToText((m as { content?: unknown }).content as MessageContent)
      .trim()
      .replace(/\s+/g, " ");
    if (!text) continue;
    const snippet =
      text.length > SUMMARY_SNIPPET_MAX_CHARS
        ? text.slice(0, SUMMARY_SNIPPET_MAX_CHARS) + "…"
        : text;
    if (parts.length > 0 && total + snippet.length > SUMMARY_MAX_CHARS) break;
    parts.push({ role: m.role === "user" ? "user" : "agent", text: snippet });
    total += snippet.length;
  }
  return parts;
}
