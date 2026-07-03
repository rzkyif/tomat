// Sessions / messages / attachments store, backed by plain JSON files on disk
// (one dir per session under ~/.tomat/<channel>/core/sessions/), the way the
// old tomat Client stored them. Each session is a single `session.json`
// holding its metadata, messages, and attachment records; attachment bytes live
// next to it under `attachments/` (written by the HTTP route, recorded here).
//
// All I/O goes through the host filesystem (async), so the store is
// runtime-agnostic. Because an async read-modify-write of one `session.json` CAN
// interleave with another caller's (there's an await between read and write), a
// per-session async lock (`withSessionLock`) serializes every mutation on a given
// session id, giving the lost-update safety the old synchronous path got for
// free. Writes are atomic (tmp file + rename).
//
// Owner-scoping mirrors the old SQL WHERE owner_client_id clauses: a wrong
// owner surfaces as session_not_found, so cross-client access is impossible.

import {
  contentToText,
  errMessage,
  type Message,
  type MessageContent,
  type Session,
  type SessionListEntry,
  type SummaryPart,
} from "@tomat/shared";
import { join } from "@std/path";
import { enginePaths, sessionAttachmentsDir, sessionDir } from "../platform/paths.ts";
import { host } from "../platform/runtime.ts";
import { AppError } from "../platform/errors.ts";
import { newAttachmentId, newMessageId, newSessionId } from "../platform/ids.ts";
import { getLogger } from "../platform/log.ts";

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

// Per-session serialization. Each id chains its mutations on one promise so two
// concurrent read-modify-writes can't interleave and lose an update (the old
// synchronous store got this for free). The entry is dropped once its chain
// drains and no newer op replaced it, so the map doesn't grow per session.
const sessionLocks = new Map<string, Promise<unknown>>();
function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const gate = run.then(
    () => {},
    () => {},
  );
  sessionLocks.set(id, gate);
  void gate.finally(() => {
    if (sessionLocks.get(id) === gate) sessionLocks.delete(id);
  });
  return run;
}

export class SessionsRepo {
  // --- sessions ------------------------------------------------------------

  async create(input: CreateSessionInput): Promise<Session> {
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
      await writeDoc(doc);
    }
    return toSession(doc);
  }

  async list(ownerClientId: string): Promise<SessionListEntry[]> {
    const docs = (await readAllDocs()).filter((d) => d.ownerClientId === ownerClientId);
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

  async getOrThrow(ownerClientId: string, sessionId: string): Promise<Session> {
    return toSession(await this.requireOwned(ownerClientId, sessionId));
  }

  patchTitle(ownerClientId: string, sessionId: string, title: string): Promise<void> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireOwned(ownerClientId, sessionId);
      doc.title = title;
      doc.updatedAtMs = Date.now();
      await writeDoc(doc);
    });
  }

  setTokenUsage(sessionId: string, tokenUsage: Session["tokenUsage"]): Promise<void> {
    return withSessionLock(sessionId, async () => {
      // Owner-agnostic, like the old UPDATE; a missing session is a silent no-op.
      const doc = await readDoc(sessionId);
      if (!doc) return;
      doc.tokenUsage = tokenUsage;
      doc.updatedAtMs = Date.now();
      await writeDoc(doc);
    });
  }

  delete(ownerClientId: string, sessionId: string): Promise<{ attachmentPaths: string[] }> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireOwned(ownerClientId, sessionId);
      const attachmentPaths = doc.attachments.map((a) => a.absPath);
      await removeSessionDir(sessionId);
      return { attachmentPaths };
    });
  }

  /** Drop every temporary session this client owns except `keepId`. A client
   *  has at most one reachable temporary session (they are never listed, so
   *  there is no way back to an older one), so any other temporary session it
   *  owns was orphaned by navigating away without a clean delete (a crash or a
   *  dropped request). Calling this on each navigation / creation reclaims the
   *  RAM (and any on-disk attachment bytes) promptly instead of waiting for a
   *  core restart. `removeSessionDir` recurses, so attachment files go too. */
  async sweepClientTemporary(ownerClientId: string, keepId?: string): Promise<void> {
    const stale = [...ephemeral.values()]
      .filter((d) => d.ownerClientId === ownerClientId && d.id !== keepId)
      .map((d) => d.id);
    for (const id of stale) await removeSessionDir(id);
  }

  // --- messages ------------------------------------------------------------

  async listMessages(sessionId: string): Promise<Message[]> {
    return (await readDoc(sessionId))?.messages ?? [];
  }

  appendMessage(sessionId: string, message: Message): Promise<{ id: string; ord: number }> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireExists(sessionId);
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
      await writeDoc(doc);
      return { id, ord };
    });
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
  ): Promise<{ id: string; ord: number }> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireExists(sessionId);
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
      await writeDoc(doc);
      return { id, ord: stored.ord };
    });
  }

  /** Remove every message strictly between the anchor and the next-newer
   *  `role: "user"` message (i.e. the old contents of the anchor's turn).
   *  Returns the removed ids so the caller can broadcast deletions. Unknown
   *  anchor = no-op. */
  deleteTurn(sessionId: string, anchorMessageId: string): Promise<string[]> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireExists(sessionId);
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
      await writeDoc(doc);
      return removed.map((m) => m.id);
    });
  }

  async getMessage(sessionId: string, messageId: string): Promise<Message> {
    const doc = await this.requireExists(sessionId);
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
  ): Promise<{ id: string; ord: number }> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireExists(sessionId);
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
      await writeDoc(doc);
      return { id: current.id, ord: current.ord };
    });
  }

  deleteMessage(sessionId: string, messageId: string): Promise<void> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireExists(sessionId);
      const idx = doc.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) {
        throw new AppError("message_not_found", "message not found");
      }
      doc.messages.splice(idx, 1);
      doc.updatedAtMs = Date.now();
      await writeDoc(doc);
    });
  }

  // --- attachments ---------------------------------------------------------

  recordAttachment(
    sessionId: string,
    messageId: string,
    filename: string,
    mime: string | undefined,
    sizeBytes: number,
    absPath: string,
  ): Promise<AttachmentRecord> {
    return withSessionLock(sessionId, async () => {
      const doc = await this.requireExists(sessionId);
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
      await writeDoc(doc);
      return record;
    });
  }

  async getAttachment(sessionId: string, attachmentId: string): Promise<AttachmentRecord> {
    const doc = await readDoc(sessionId);
    const att = doc?.attachments.find((a) => a.id === attachmentId);
    if (!att) throw new AppError("not_found", "attachment not found");
    return att;
  }

  // --- storage view (all clients) ------------------------------------------

  /** Every session across all clients with its on-disk footprint. Used by the
   *  Settings → Storage view, which spans clients (the per-client `list` is for
   *  the session bar). */
  async listAll(): Promise<
    Array<{
      id: string;
      ownerClientId: string;
      title: string;
      updatedAtMs: number;
      sizeBytes: number;
    }>
  > {
    const docs = await readAllDocs();
    return await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        ownerClientId: d.ownerClientId,
        title: d.title,
        updatedAtMs: d.updatedAtMs,
        sizeBytes:
          (await statSize(sessionFile(d.id))) + (await dirSize(sessionAttachmentsDir(d.id))),
      })),
    );
  }

  /** Delete a session without knowing its owner (admin / storage-view path).
   *  Returns null if it doesn't exist. */
  deleteById(
    sessionId: string,
  ): Promise<{ ownerClientId: string; attachmentPaths: string[] } | null> {
    return withSessionLock(sessionId, async () => {
      const doc = await readDoc(sessionId);
      if (!doc) return null;
      const attachmentPaths = doc.attachments.map((a) => a.absPath);
      await removeSessionDir(sessionId);
      return { ownerClientId: doc.ownerClientId, attachmentPaths };
    });
  }

  // --- helpers -------------------------------------------------------------

  private async requireOwned(ownerClientId: string, sessionId: string): Promise<SessionDoc> {
    const doc = await readDoc(sessionId);
    if (!doc || doc.ownerClientId !== ownerClientId) {
      throw new AppError("session_not_found", `session ${sessionId} not found`);
    }
    return doc;
  }

  private async requireExists(sessionId: string): Promise<SessionDoc> {
    const doc = await readDoc(sessionId);
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
// sessions + any pending per-session locks, so each test starts from a clean
// slate (disk is otherwise the source of truth).
export function __resetForTesting(): void {
  _instance = null;
  ephemeral.clear();
  sessionLocks.clear();
}

/** Remove any session directory that has no readable `session.json`. The only
 *  way such a directory exists is a temporary session whose attachments were
 *  written to disk (by the attachments route) but whose doc lived only in RAM
 *  and so was lost on an unclean shutdown. A persistent session always writes
 *  `session.json` at creation, before any attachment, so this never touches a
 *  real session. Run once at core boot. */
export async function sweepOrphanedSessionDirs(): Promise<void> {
  if (!(await host().fs.stat(enginePaths().sessionsDir))) return;
  for (const e of await host().fs.readDir(enginePaths().sessionsDir)) {
    if (!e.isDir) continue;
    // Existence, not parseability: a corrupt-but-present session.json is a real
    // session readDoc skips, not an orphan to delete.
    if (await fileExists(sessionFile(e.name))) continue;
    try {
      await host().fs.remove(sessionDir(e.name), { recursive: true });
      log.info(`swept orphaned session dir ${e.name} (no session.json)`);
    } catch (err) {
      log.warn(`failed to sweep orphaned session dir ${e.name}: ${errMessage(err)}`);
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

async function readDoc(id: string): Promise<SessionDoc | null> {
  const mem = ephemeral.get(id);
  // Clone so a temporary session reads exactly like a persistent one: every
  // readDoc hands back a private snapshot, and the map entry only changes
  // through writeDoc. Returning the live object instead would let an in-place
  // mutation (harmless on the disk path's throwaway parse) silently corrupt
  // the canonical state.
  if (mem) return structuredClone(mem);
  const file = sessionFile(id);
  if (!(await host().fs.stat(file))) return null;
  let text: string;
  try {
    text = await host().fs.readTextFile(file);
  } catch (err) {
    // Statted-present but unreadable now (a race with a concurrent delete, or a
    // permission issue): treat as absent rather than throwing into a listing.
    log.warn(`could not read session.json for ${id}; skipping: ${errMessage(err)}`);
    return null;
  }
  let parsed: SessionDoc;
  try {
    parsed = JSON.parse(text) as SessionDoc;
  } catch (err) {
    // A truncated / corrupt file must not poison list() / listAll() / GC for
    // every other session: treat it as absent (skipped) rather than throwing.
    log.warn(`corrupt session.json for ${id}; skipping: ${errMessage(err)}`);
    return null;
  }
  // Defensive defaults so an older / partial file still loads.
  parsed.messages ??= [];
  parsed.attachments ??= [];
  return parsed;
}

async function writeDoc(doc: SessionDoc): Promise<void> {
  // A temporary session lives only in the map: commit the (snapshot) doc the
  // caller mutated, mirroring how the disk path commits via tmp+rename, and
  // short-circuit before any filesystem access.
  if (ephemeral.has(doc.id)) {
    ephemeral.set(doc.id, doc);
    return;
  }
  await host().fs.mkdir(sessionDir(doc.id), { recursive: true });
  await host().fs.writeTextFileAtomic(sessionFile(doc.id), JSON.stringify(doc, null, 2));
}

async function readAllDocs(): Promise<SessionDoc[]> {
  const out: SessionDoc[] = [];
  if (!(await host().fs.stat(enginePaths().sessionsDir))) return out;
  for (const e of await host().fs.readDir(enginePaths().sessionsDir)) {
    if (!e.isDir) continue;
    const doc = await readDoc(e.name);
    if (doc) out.push(doc);
  }
  return out;
}

async function removeSessionDir(id: string): Promise<void> {
  ephemeral.delete(id);
  // host.fs.remove is idempotent (missing path is a no-op).
  await host().fs.remove(sessionDir(id), { recursive: true });
}

function nextOrd(messages: Message[]): number {
  let max = -1;
  for (const m of messages) if (m.ord > max) max = m.ord;
  return max + 1;
}

async function statSize(path: string): Promise<number> {
  return (await host().fs.stat(path))?.size ?? 0;
}

async function fileExists(path: string): Promise<boolean> {
  return (await host().fs.stat(path))?.isDir === false;
}

async function dirSize(path: string): Promise<number> {
  const st = await host().fs.stat(path);
  if (!st || !st.isDir) return 0;
  let total = 0;
  for (const e of await host().fs.readDir(path)) {
    const full = join(path, e.name);
    if (e.isDir) total += await dirSize(full);
    else total += await statSize(full);
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
