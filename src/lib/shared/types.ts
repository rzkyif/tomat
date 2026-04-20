/**
 * Shared TypeScript types used across the app: messages, attachments,
 * tool calls, server status, and session info. The shapes here are the
 * common vocabulary between the UI, the state stores, and the sidecar
 * layer.
 */

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
  role: "user" | "assistant" | "error" | "system";
  content: MessageContent;
  modelUsed?: "default" | "secondary";
  /** Only populated on user messages. Holds the resolved system prompt that
   *  was sent to the LLM for that turn, including any snippet-triggered
   *  transformations. Used by sendMessages() on edit-and-resend. */
  systemPromptOverride?: string;
  /** Only populated on assistant messages when the model emits a reasoning
   *  trace and `llm.showReasoning` is enabled. Persisted with the session but
   *  never sent back to the LLM (contentToApi only reads `content`). */
  reasoning?: string;
  /** Elapsed time (ms) from the first reasoning chunk to the first content
   *  chunk (or stream finish if no content). Captured once per assistant turn
   *  so historic messages can still render "Thought for Xs". */
  reasoningDurationMs?: number;
};

/** Generate a message id. User message ids are set separately from their
 *  attachment timestamp (see `addUserMessage`) so this only needs to be
 *  unique, not a bare timestamp. A process-local counter guards against
 *  same-millisecond collisions between assistant / system / tool messages
 *  minted back-to-back in a single event loop turn. */
let messageIdCounter = 0;
export function makeMessageId(): string {
  return `${Date.now()}-${(++messageIdCounter).toString(36)}`;
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
