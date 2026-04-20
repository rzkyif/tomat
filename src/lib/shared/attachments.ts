/**
 * Helpers for working with message attachments: base64 encode/decode,
 * save / load / delete attachment files through the Rust backend, and
 * figure out which files belong to a given message.
 */

import { invoke } from "@tauri-apps/api/core";
import type { MessageContent, MessagePart } from "./types";

export type WrittenAttachment = { path: string; filename: string };

/** Base64-encode a UTF-8 string (used for document markdown payloads). */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Decode base64 → UTF-8 string. */
export function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Write an attachment payload into the session directory via the Rust command. */
export async function writeSessionAttachment(
  sessionId: string,
  messageTimestamp: string,
  filename: string,
  dataBase64: string,
): Promise<WrittenAttachment> {
  return (await invoke("write_session_attachment", {
    sessionId,
    messageTimestamp,
    filename,
    dataBase64,
  })) as WrittenAttachment;
}

/** Read an attachment file from disk and return it as base64. */
export async function readSessionAttachment(path: string): Promise<string> {
  return (await invoke("read_session_attachment", { path })) as string;
}

/** Delete attachment files from disk. Silently ignores missing paths. */
export async function deleteSessionAttachments(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await invoke("delete_session_attachments", { paths });
  } catch (e) {
    console.warn("[attachments] delete failed:", e);
  }
}

/** Collect the file paths referenced by any `_file` parts inside a message. */
export function collectAttachmentPaths(content: MessageContent): Set<string> {
  const out = new Set<string>();
  if (typeof content === "string") return out;
  for (const part of content) {
    if (part.type === "image_file" || part.type === "document_file") {
      out.add(part.path);
    }
  }
  return out;
}

/** Paths present in `prev` but not in `next`. */
export function diffRemovedAttachmentPaths(prev: MessageContent, next: MessageContent): string[] {
  const prevPaths = collectAttachmentPaths(prev);
  const nextPaths = collectAttachmentPaths(next);
  const removed: string[] = [];
  for (const p of prevPaths) {
    if (!nextPaths.has(p)) removed.push(p);
  }
  return removed;
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export function imageExtFromMime(mime: string): string {
  return IMAGE_EXT_BY_MIME[mime.toLowerCase()] || "png";
}

/** Ensure a document filename has a `.md` extension so on-disk content matches the payload. */
export function ensureMarkdownExtension(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md")) return filename;
  return `${filename}.md`;
}

/** Preview display list: maps persisted `_file` parts to legacy display shape the AttachmentList expects. */
export function toPreviewParts(content: MessageContent): MessagePart[] {
  if (typeof content === "string") return [];
  return content.filter(
    (p): p is MessagePart =>
      p.type === "document" ||
      p.type === "image_url" ||
      p.type === "document_file" ||
      p.type === "image_file",
  );
}
