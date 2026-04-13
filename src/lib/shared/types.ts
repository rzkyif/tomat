export type MessagePart =
  | { type: "text"; text: string }
  // In-memory forms used only between user picking an attachment and the message being flushed to disk.
  | { type: "image_url"; image_url: { url: string } }
  | { type: "document"; filename: string; markdown: string }
  // Persisted forms written into session JSON: point at a file under ~/.tomat/sessions/<id>/.
  | { type: "image_file"; filename: string; path: string; mime: string }
  | { type: "document_file"; filename: string; path: string };

export type MessageContent = string | MessagePart[];

export type Message = {
  /** Stable client-generated id used for TTS replay controls. Backfilled on
   *  load for messages persisted before this field existed. */
  id?: string;
  role: "user" | "assistant" | "error";
  content: MessageContent;
  modelUsed?: "default" | "secondary";
};

/** Generate a message id. Kept consistent with the attachment-folder
 *  `<message_timestamp>-<filename>` scheme: a user message's id matches the
 *  timestamp prefix used for any attachments it owns. */
export function makeMessageId(): string {
  return Date.now().toString();
}
export type Monitor = { id: string | number; name: string; isPrimary: boolean };
export type Alignment = "left" | "center" | "right";

export type ServerStatus = "Disabled" | "Error" | "Downloading" | "Loading" | "Running";

export interface ServerStatusUpdate {
  server: "llm" | "stt" | "bun";
  status: ServerStatus;
  progress?: number;
  message?: string;
}

export type LLMErrorType =
  | "rate_limit_error"
  | "context_length_exceeded_error"
  | "authentication_error"
  | "invalid_request_error"
  | "server_error"
  | "unknown_error";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type SessionInfo = {
  id: string;
  title: string;
};

export type Attachment = {
  type: "image" | "document";
  filename: string;
  // Base64 (images) or markdown (documents). Lives in memory until the
  // containing message is sent and flushed to disk.
  pendingData: string;
  mime?: string;
};

/** Extract plain text from MessageContent, regardless of format */
export function getTextContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
