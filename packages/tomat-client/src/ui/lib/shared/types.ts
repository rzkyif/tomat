/**
 * Shared TypeScript types used across the app: messages, attachments,
 * tool calls, server status, and session info. The shapes here are the
 * common vocabulary between the UI, the state stores, and the sidecar
 * layer.
 */

// Re-export canonical definitions from the shared package so client and core
// agree on the wire shape. `path` on `*_file` parts is the core REST URL
// (/api/v1/sessions/:sid/attachments/:aid) returned by the upload endpoint;
// the server parses the trailing :aid to load bytes when building the LLM
// request. The import + re-export form is needed because plain
// `export type {} from "..."` doesn't bring the name into the local scope
// for use in interfaces below.
import type { MessageContent, MessagePart } from "@tomat/shared";
export type { MessageContent, MessagePart };

/** Lifecycle of a single tool invocation as seen by the UI. */
export type ToolCallStatus =
  | "pending"
  | "running"
  | "awaiting_user"
  | "complete"
  | "failed"
  | "cancelled";

export type AskUserQuestion = {
  question: string;
  options?: { label: string; description?: string; value: string }[];
  multiselect?: boolean;
  allowFreeformInput?: boolean;
};

/** Answer shape: string for text/freeform, chosen option `value` for
 *  single-select, string[] for multiselect. */
export type AskUserAnswer = string | string[];

export type ToolCallAskUserState = {
  requestId: string;
  questions: AskUserQuestion[];
  answers: AskUserAnswer[] | null;
};

export type ToolCallLogLine = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  ts: number;
};

export type ToolCallState = {
  /** Server-generated unique id for this invocation. Routes WS events. */
  callId: string;
  /** OpenAI tool_call_id echoed back when the tool result is sent to the LLM. */
  toolCallId: string;
  toolkitId: string;
  toolName: string;
  /** Parsed arguments object (may be {} if the model produced invalid JSON). */
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  progress?: number;
  label?: string;
  description?: string;
  askUser?: ToolCallAskUserState;
  result?: unknown;
  error?: string;
  logs: ToolCallLogLine[];
};

// Mirrors the on-the-wire shape from `@tomat/shared`'s `PendingToolCall`
// frame field. Re-exported from this module so callers in `lib/state/`
// can keep the existing import path while the field names stay aligned
// with the wire format — saving a cast at the streaming dispatcher.
import type { PendingToolCall as WirePendingToolCall } from "@tomat/shared";
export type PendingToolCall = WirePendingToolCall;

/** A single phase-1 (embedding similarity) candidate, snapshot for the
 *  bubble. Field names mirror the on-the-wire `ToolFilterPhase1Entry`
 *  frame shape so the streaming dispatcher can assign without remapping. */
export type RelevantToolPhase1Entry = {
  toolId: string;
  name: string;
  description: string;
  score: number;
};

/** A single phase-2 (LLM filter) survivor. No score: phase 2 is binary
 *  keep/drop. Mirrors the `ToolFilterEntry` frame shape (carrying
 *  `toolId` so the bubble can key its `{#each}` reliably). */
export type RelevantToolPhase2Entry = {
  toolId: string;
  name: string;
  description: string;
};

export type RelevantToolsState = {
  status: "filtering" | "complete" | "error";
  /** null = phase 1 (embedding similarity) didn't run for this turn. Happens
   *  when the user's filtering toggle is off or the threshold-bypass kicks
   *  in. Empty array means "ran but produced nothing". */
  phase1: RelevantToolPhase1Entry[] | null;
  /** null = phase 2 (LLM filter) didn't run. Empty array means "ran but
   *  produced nothing". */
  phase2: RelevantToolPhase2Entry[] | null;
  /** null = always-available bypass didn't run (toggle off OR no qualifying
   *  tools exist). Empty array means "ran but no tools were appended"
   *  (rare: every alwaysAvailable tool was already in phase2). When phase1
   *  + phase2 are both null and this is a non-empty list, the bubble shows
   *  only this section (filter pipeline was bypassed; all enabled tools are
   *  surfaced here). */
  alwaysAvailable: RelevantToolPhase2Entry[] | null;
  /** Populated when the filter LLM call failed; phase2 falls back to phase1 in
   *  that case so tools still reach the main model. */
  errorMessage?: string;
};

export type Message = {
  /** Stable client-generated id used for TTS replay controls. Backfilled on
   *  load for messages persisted before this field existed. */
  id?: string;
  role:
    | "user"
    | "assistant"
    | "reasoning"
    | "error"
    | "system"
    | "tool"
    | "tool_filter"
    /** Synthetic, render-only role. The +page rendering pipeline injects a
     *  single `role: "loading"` Message into its derived display list while
     *  awaiting the first response chunk so a transient spinner bubble flows
     *  through the same small-bubble stacking layout as adjacent reasoning /
     *  tool_filter / system bubbles. Never persisted, never added to
     *  messagesState.messages, never sent to the LLM. */
    | "loading";
  content: MessageContent;
  modelUsed?: "default" | "secondary";
  /** Only populated on user messages. Holds the resolved system prompt that
   *  was sent to the LLM for that turn, including any snippet-triggered
   *  transformations. Used by sendMessages() on edit-and-resend. */
  systemPromptOverride?: string;
  /** Only populated on `role: "reasoning"` messages. Elapsed time (ms) from
   *  the first reasoning chunk to the first content chunk (or stream finish
   *  if no content). Captured once per turn so historic messages can still
   *  render "Thought for Xs". */
  reasoningDurationMs?: number;
  /** Only populated on `role: "reasoning"` messages. Points back at the
   *  assistant content message produced in the same turn. Used to delete /
   *  reprocess the pair atomically. */
  pairedAssistantId?: string;
  /** Set on a `role: "tool"` message. Drives the ToolCall bubble. */
  toolCall?: ToolCallState;
  /** Set on a `role: "tool_filter"` message. Drives the RelevantTools bubble. */
  relevantTools?: RelevantToolsState;
  /** Set on an assistant message that produced tool_calls in its final chunk.
   *  Used to re-materialize `role: "tool"` messages on edit-and-resend. */
  pendingToolCalls?: PendingToolCall[];
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

export type ServerStatus = "Disabled" | "Error" | "Loading" | "Running";

export interface ServerStatusUpdate {
  // After the rework the sidecar kinds are "llama"/"whisper"/"tts"/"tool"
  // (per @tomat/shared) but legacy components still read "llm"/"stt"/"bun".
  // Keep this string-typed for compatibility; convert at the read site if
  // strict matching is ever required.
  server: string;
  status: ServerStatus;
  progress?: number;
  message?: string;
}

export type DownloadStatus = "Pending" | "Downloading" | "Completed" | "Error" | "Cancelled";
export type DownloadDestination = "Models";

// Wire-format DownloadEntry (camelCase per the new shared API). Keeping
// the old `DownloadItem` name + snake_case aliases as getters would be
// a migration crust we explicitly avoid; UI sites that read these fields
// switch to camelCase as part of the rework.
export interface DownloadItem {
  id: string;
  source: string;
  destination: "models" | "binaries" | "toolkits";
  relPath: string;
  absPath: string;
  filename: string;
  groupId: string;
  sizeBytes?: number;
  downloadedBytes: number;
  status: DownloadStatus;
  error?: string;
  addedAtMs: number;
}

export type LLMErrorType =
  | "rate_limit_error"
  | "context_length_exceeded_error"
  | "authentication_error"
  | "invalid_request_error"
  | "server_error"
  | "unknown_error";

// Local re-export of the server-defined wire shape so the rest of the
// client can keep importing `TokenUsage` from `$lib/shared/types`. The
// canonical definition lives in @tomat/shared/domain/session.ts.
import type { TokenUsage as SharedTokenUsage } from "@tomat/shared";
export type TokenUsage = SharedTokenUsage;

export type SessionInfo = {
  id: string;
  title: string;
};

/** Wire shape returned by the server when re-hydrating a session. */
export interface ChatHistoryPayload {
  sessionId: string;
  title: string;
  contextUsage: TokenUsage | null;
  messages: Message[];
}

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
