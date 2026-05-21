// Session, Message, and tool-call state types shared between core and client.
// Message persistence lives core-side; the client renders these shapes.

export type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "reasoning"
  | "tool_filter"
  | "error";

export interface AttachmentRef {
  id: string;
  filename: string;
  mime?: string;
  sizeBytes: number;
  // Core-relative URL the client uses to fetch bytes via the authed REST API.
  url: string;
}

// Multipart message content. A user message with no attachments is a plain
// `string`; once any attachment or inline image lands on the message, content
// becomes a `MessagePart[]` so each piece (text, image, document) can be
// rendered + serialized independently. `path` on `*_file` parts is the
// core-relative `/api/v1/sessions/:sid/attachments/:aid` URL produced by
// `uploadAttachment` — the server parses the trailing `:aid` to load bytes
// from disk when building the LLM request.
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "image_file"; filename: string; path: string; mime: string }
  | { type: "document"; filename: string; markdown: string }
  | { type: "document_file"; filename: string; path: string };

export type MessageContent = string | MessagePart[];

/** True when content is a multipart array. */
export function isMultipart(c: MessageContent): c is MessagePart[] {
  return Array.isArray(c);
}

/** Flatten multipart content to a plain text representation (text parts
 *  joined; non-text parts dropped). Used by title generation, last-user-text
 *  lookups, and any code that wants a string regardless of attachments. */
export function contentToText(c: MessageContent): string {
  if (typeof c === "string") return c;
  return c
    .filter((p): p is Extract<MessagePart, { type: "text" }> =>
      p.type === "text"
    )
    .map((p) => p.text)
    .join("");
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export type ToolCallStatus =
  | "pending"
  | "running"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolCall {
  callId: string;
  toolkitId: string;
  toolName: string;
  arguments: string; // JSON string the LLM emitted
  status: ToolCallStatus;
  result?: unknown; // present when status === "completed"
  error?: string; // present when status === "failed"
  progress?: { value: number; label?: string; description?: string };
  logLines?: Array<
    {
      level: "debug" | "info" | "warn" | "error";
      message: string;
      atMs: number;
    }
  >;
}

// Base fields every message carries. Concrete shapes are role-specific below.
interface MessageBase {
  id: string;
  ord: number;
  createdAtMs: number;
}

export interface UserMessage extends MessageBase {
  role: "user";
  // Plain string when there are no attachments. Once an image/document is
  // attached the client switches to multipart so each piece can be rendered
  // and sent to the LLM independently (vision models expect `image_url`
  // parts; documents are inlined as text with a "[Attached document: …]"
  // prefix server-side).
  content: MessageContent;
  // Resolved system prompt that was sent to the LLM for THIS turn,
  // including any snippet-triggered transformations. Populated when a
  // snippet overrode the user's default system prompt; absent otherwise.
  // Used by edit-and-resend to replay the same prompt context.
  systemPromptOverride?: string;
}

export interface AssistantMessage extends MessageBase {
  role: "assistant";
  content: string;
  // True while the assistant message is still being streamed; false once
  // the stream completes (or is interrupted). Client uses this to render
  // a typing indicator.
  streaming?: boolean;
  toolCalls?: ToolCall[];
  // Tool calls the model emitted in its final chunk but whose results
  // haven't been resolved yet. Used by edit-and-resend to re-materialize
  // the pending `role: "tool"` rows.
  pendingToolCalls?: ToolCall[];
  // Which model role produced this turn — "default" for the primary local /
  // external endpoint, "secondary" when dual-model routing kicked in.
  // Drives the model-name chip the UI renders next to the bubble.
  modelUsed?: "default" | "secondary";
}

export interface SystemMessage extends MessageBase {
  role: "system";
  content: string;
}

export interface ToolMessage extends MessageBase {
  role: "tool";
  callId: string;
  toolkitId: string;
  toolName: string;
  result?: unknown;
  error?: string;
  status: ToolCallStatus;
}

export interface ReasoningMessage extends MessageBase {
  role: "reasoning";
  content: string;
  // Streamed reasoning bubble may still be growing.
  streaming?: boolean;
  // ms between the first reasoning chunk and the first content chunk (or
  // stream end if the model never emitted content). Lets the UI render
  // "Thought for Xs" without recomputing from timestamps.
  reasoningDurationMs?: number;
  // ID of the AssistantMessage produced in the same turn. Used by the UI
  // to pair the bubbles and by edit-and-resend to delete both atomically.
  pairedAssistantId?: string;
  // Which model role produced this trace. Mirrors AssistantMessage.modelUsed
  // so the reasoning bubble can carry the same chip.
  modelUsed?: "default" | "secondary";
}

// Per-entry shape carried by the tool_filter bubble. Phase-1 entries also
// carry a cosine similarity score so the UI can rank them visually.
export interface ToolFilterPhase1Persisted {
  toolId: string;
  name: string;
  description: string;
  score: number;
}
export interface ToolFilterEntryPersisted {
  toolId: string;
  name: string;
  description: string;
}

export interface ToolFilterMessage extends MessageBase {
  role: "tool_filter";
  status: "filtering" | "complete" | "error";
  // Candidates ranked by embedding cosine (phase-1 RAG).
  phase1?: ToolFilterPhase1Persisted[];
  // Subset kept by the second-pass LLM filter, if enabled.
  phase2?: ToolFilterEntryPersisted[];
  // Tools whose toolkit declares `alwaysAvailable: true`; included
  // regardless of filtering when the bypass setting is on.
  alwaysAvailable?: ToolFilterEntryPersisted[];
  errorMessage?: string;
}

export interface ErrorMessage extends MessageBase {
  role: "error";
  content: string;
  // Optional structured error context (provider error, scheduler error, etc.).
  code?: string;
  details?: Record<string, unknown>;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ToolMessage
  | ReasoningMessage
  | ToolFilterMessage
  | ErrorMessage;

export interface Session {
  id: string;
  ownerClientId: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokenUsage?: TokenUsage;
}

export interface SessionListEntry {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageCount: number;
}
