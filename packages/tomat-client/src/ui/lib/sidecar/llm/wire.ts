/**
 * Conversion of in-app `MessageContent` into the OpenAI wire format. Lives
 * outside `client.ts` and `stream.ts` so both can share the same
 * attachment-materialization logic without circular imports. Materializes
 * `image_file` / `document_file` parts by reading them from the session
 * directory; warns and skips on read failure rather than aborting the
 * request.
 */

import { readSessionAttachment, base64ToUtf8 } from "$lib/shared/attachments";
import type { MessageContent } from "$lib/shared/types";

export type ApiMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function contentToApi(content: MessageContent): Promise<string | ApiMessagePart[]> {
  if (typeof content === "string") return content;

  const parts: ApiMessagePart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
    } else if (part.type === "document") {
      parts.push({
        type: "text",
        text: `[Attached document: ${part.filename}]\n\n${part.markdown}`,
      });
    } else if (part.type === "image_file") {
      try {
        const b64 = await readSessionAttachment(part.path);
        parts.push({
          type: "image_url",
          image_url: { url: `data:${part.mime};base64,${b64}` },
        });
      } catch (e) {
        console.warn("[llm] failed to load image attachment:", part.path, e);
      }
    } else if (part.type === "document_file") {
      try {
        const b64 = await readSessionAttachment(part.path);
        const markdown = base64ToUtf8(b64);
        parts.push({
          type: "text",
          text: `[Attached document: ${part.filename}]\n\n${markdown}`,
        });
      } catch (e) {
        console.warn("[llm] failed to load document attachment:", part.path, e);
      }
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}
