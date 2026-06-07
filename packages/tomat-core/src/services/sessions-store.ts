// Sessions / messages / attachments store, backed by plain JSON files on disk
// (one dir per session under ~/.tomat/<channel>/core/sessions/), the way the
// old tomat client stored them. Each session is a single `session.json`
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

// The full on-disk document for one session.
interface SessionDoc {
  id: string;
  ownerClientId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokenUsage?: Session["tokenUsage"];
  messages: Message[];
  attachments: AttachmentRecord[];
}

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
    writeDoc(doc);
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
      summary: summarizeFirstUserMessage(d.messages),
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

  getMessage(sessionId: string, messageId: string): Message {
    const doc = this.requireExists(sessionId);
    const msg = doc.messages.find((m) => m.id === messageId);
    if (!msg) throw new AppError("message_not_found", `message ${messageId} not found`);
    return msg;
  }

  patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Message>,
  ): { id: string; ord: number } {
    const doc = this.requireExists(sessionId);
    const idx = doc.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) throw new AppError("message_not_found", `message ${messageId} not found`);
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
    if (idx === -1) throw new AppError("message_not_found", "message not found");
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
    if (!doc) throw new AppError("session_not_found", `session ${sessionId} not found`);
    return doc;
  }
}

let _instance: SessionsRepo | null = null;
export function sessionsRepo(): SessionsRepo {
  if (!_instance) _instance = new SessionsRepo();
  return _instance;
}

// Test-only: drops the cached instance. The store is stateless (disk is the
// source of truth), so this mainly exists for symmetry with the other repos.
export function __resetForTesting(): void {
  _instance = null;
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
  };
}

function readDoc(id: string): SessionDoc | null {
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

const SUMMARY_MAX_CHARS = 120;

/** Plain-text snippet of the first user message, for the session list. Empty
 *  when the session has no user message yet. */
function summarizeFirstUserMessage(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  const text = contentToText((first as { content?: unknown }).content as MessageContent)
    .trim()
    .replace(/\s+/g, " ");
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) + "…" : text;
}
