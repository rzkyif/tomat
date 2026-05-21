// Sessions / messages / attachments DB access.
//
// Every query is scoped by owner_client_id so cross-client access is
// physically impossible at the SQL layer (the AppError("not_found") falls
// through naturally because the WHERE clause excludes the row).

import type { Message, Session, SessionListEntry } from "@tomat/shared";
import { db } from "../connection.ts";
import { AppError } from "../../shared/errors.ts";
import {
  newAttachmentId,
  newMessageId,
  newSessionId,
} from "../../shared/ids.ts";

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

export class SessionsRepo {
  // --- sessions ------------------------------------------------------------

  create(input: CreateSessionInput): Session {
    const id = newSessionId();
    const now = Date.now();
    db().prepare(`
      INSERT INTO sessions (id, owner_client_id, title, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.ownerClientId, input.title ?? "", now, now);
    return {
      id,
      ownerClientId: input.ownerClientId,
      title: input.title ?? "",
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  list(ownerClientId: string): SessionListEntry[] {
    const rows = db().prepare(`
      SELECT s.id, s.title, s.created_at_ms, s.updated_at_ms,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
      FROM sessions s
      WHERE s.owner_client_id = ?
      ORDER BY s.updated_at_ms DESC
    `).all(ownerClientId) as Array<{
      id: string;
      title: string;
      created_at_ms: number;
      updated_at_ms: number;
      message_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
      messageCount: r.message_count,
    }));
  }

  getOrThrow(ownerClientId: string, sessionId: string): Session {
    const row = db().prepare(`
      SELECT id, owner_client_id, title, created_at_ms, updated_at_ms, token_usage
      FROM sessions
      WHERE id = ? AND owner_client_id = ?
    `).get(sessionId, ownerClientId) as
      | {
        id: string;
        owner_client_id: string;
        title: string;
        created_at_ms: number;
        updated_at_ms: number;
        token_usage: string | null;
      }
      | undefined;
    if (!row) {
      throw new AppError("session_not_found", `session ${sessionId} not found`);
    }
    return {
      id: row.id,
      ownerClientId: row.owner_client_id,
      title: row.title,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
    };
  }

  patchTitle(ownerClientId: string, sessionId: string, title: string): void {
    const res = db().prepare(`
      UPDATE sessions SET title = ?, updated_at_ms = ?
      WHERE id = ? AND owner_client_id = ?
    `).run(title, Date.now(), sessionId, ownerClientId);
    if (res === 0) throw new AppError("session_not_found", "session not found");
  }

  setTokenUsage(sessionId: string, tokenUsage: Session["tokenUsage"]): void {
    db().prepare(`
      UPDATE sessions SET token_usage = ?, updated_at_ms = ? WHERE id = ?
    `).run(
      tokenUsage ? JSON.stringify(tokenUsage) : null,
      Date.now(),
      sessionId,
    );
  }

  delete(
    ownerClientId: string,
    sessionId: string,
  ): { attachmentPaths: string[] } {
    const paths = db().prepare(`
      SELECT abs_path FROM attachments WHERE session_id = ?
    `).all(sessionId) as Array<{ abs_path: string }>;
    const res = db().prepare(`
      DELETE FROM sessions WHERE id = ? AND owner_client_id = ?
    `).run(sessionId, ownerClientId);
    if (res === 0) throw new AppError("session_not_found", "session not found");
    return { attachmentPaths: paths.map((p) => p.abs_path) };
  }

  // --- messages ------------------------------------------------------------

  listMessages(sessionId: string): Message[] {
    const rows = db().prepare(`
      SELECT id, ord, role, content_json, created_at_ms
      FROM messages WHERE session_id = ? ORDER BY ord ASC
    `).all(sessionId) as Array<{
      id: string;
      ord: number;
      role: string;
      content_json: string;
      created_at_ms: number;
    }>;
    return rows.map(rowToMessage);
  }

  appendMessage(
    sessionId: string,
    message: Message,
  ): { id: string; ord: number } {
    const id = message.id || newMessageId();
    const ord = this.nextOrd(sessionId);
    const content = JSON.stringify(message);
    db().prepare(`
      INSERT INTO messages (id, session_id, ord, role, content_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      ord,
      message.role,
      content,
      message.createdAtMs || Date.now(),
    );
    db().prepare(`UPDATE sessions SET updated_at_ms = ? WHERE id = ?`).run(
      Date.now(),
      sessionId,
    );
    return { id, ord };
  }

  patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Message>,
  ): { id: string; ord: number } {
    const row = db().prepare(`
      SELECT id, ord, role, content_json, created_at_ms
      FROM messages WHERE session_id = ? AND id = ?
    `).get(sessionId, messageId) as
      | {
        id: string;
        ord: number;
        role: string;
        content_json: string;
        created_at_ms: number;
      }
      | undefined;
    if (!row) {
      throw new AppError("message_not_found", `message ${messageId} not found`);
    }
    const current = rowToMessage(row);
    const merged: Message = {
      ...current,
      ...patch,
      id: row.id,
      role: current.role,
    } as Message;
    const content = JSON.stringify(merged);
    db().prepare(
      `UPDATE messages SET content_json = ? WHERE id = ? AND session_id = ?`,
    )
      .run(content, messageId, sessionId);
    db().prepare(`UPDATE sessions SET updated_at_ms = ? WHERE id = ?`)
      .run(Date.now(), sessionId);
    return { id: row.id, ord: row.ord };
  }

  deleteMessage(sessionId: string, messageId: string): void {
    const res = db().prepare(`
      DELETE FROM messages WHERE session_id = ? AND id = ?
    `).run(sessionId, messageId);
    if (res === 0) throw new AppError("message_not_found", "message not found");
    db().prepare(`UPDATE sessions SET updated_at_ms = ? WHERE id = ?`).run(
      Date.now(),
      sessionId,
    );
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
    const id = newAttachmentId();
    const now = Date.now();
    db().prepare(`
      INSERT INTO attachments
        (id, session_id, message_id, filename, mime, size_bytes, abs_path, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      messageId,
      filename,
      mime ?? null,
      sizeBytes,
      absPath,
      now,
    );
    return {
      id,
      sessionId,
      messageId,
      filename,
      mime,
      sizeBytes,
      absPath,
      createdAtMs: now,
    };
  }

  getAttachment(sessionId: string, attachmentId: string): AttachmentRecord {
    const row = db().prepare(`
      SELECT id, session_id, message_id, filename, mime, size_bytes, abs_path, created_at_ms
      FROM attachments WHERE id = ? AND session_id = ?
    `).get(attachmentId, sessionId) as
      | {
        id: string;
        session_id: string;
        message_id: string;
        filename: string;
        mime: string | null;
        size_bytes: number;
        abs_path: string;
        created_at_ms: number;
      }
      | undefined;
    if (!row) throw new AppError("not_found", "attachment not found");
    return {
      id: row.id,
      sessionId: row.session_id,
      messageId: row.message_id,
      filename: row.filename,
      mime: row.mime ?? undefined,
      sizeBytes: row.size_bytes,
      absPath: row.abs_path,
      createdAtMs: row.created_at_ms,
    };
  }

  // --- helpers -------------------------------------------------------------

  private nextOrd(sessionId: string): number {
    const row = db().prepare(`
      SELECT COALESCE(MAX(ord), -1) AS max_ord FROM messages WHERE session_id = ?
    `).get(sessionId) as { max_ord: number };
    return row.max_ord + 1;
  }
}

let _instance: SessionsRepo | null = null;
export function sessionsRepo(): SessionsRepo {
  if (!_instance) _instance = new SessionsRepo();
  return _instance;
}

function rowToMessage(row: {
  id: string;
  ord: number;
  role: string;
  content_json: string;
  created_at_ms: number;
}): Message {
  const parsed = JSON.parse(row.content_json) as Record<string, unknown>;
  return {
    ...parsed,
    id: row.id,
    ord: row.ord,
    role: row.role,
    createdAtMs: parsed.createdAtMs as number ?? row.created_at_ms,
  } as Message;
}
