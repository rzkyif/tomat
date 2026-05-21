// WebSocket frame envelope shapes for /ws/v1.
// Multiplexed: every frame carries the discriminator it needs
// (streamId / callId / jobId) for the client to route it.

import type { AttachmentRef, TokenUsage, ToolCall } from "../domain/session.ts";
import type { DownloadEntry, SidecarSnapshot } from "../domain/model.ts";
import type { ErrorCode } from "./errors.ts";

// --- Client → Server -------------------------------------------------------

export type ClientToServerFrame =
  | { kind: "ping" }
  | {
    kind: "chat.start";
    streamId: string;
    sessionId: string;
    route?: "default" | "secondary";
    contextOverride?: Array<{ role: string; content: string }>;
  }
  | { kind: "chat.interrupt"; streamId: string }
  | {
    kind: "tool.askuser_response";
    callId: string;
    requestId: string;
    answers: Array<string | string[]>;
  }
  | { kind: "tool.cancel"; callId: string };

// --- Server → Client -------------------------------------------------------

export interface PendingToolCall {
  callId: string;
  toolkitId: string;
  toolName: string;
  arguments: string;
}

export interface AskUserQuestion {
  question: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  multiselect?: boolean;
  allowFreeformInput?: boolean;
}

/** Entry shown in the "relevant tools" bubble for phase-1 (RAG). */
export interface ToolFilterPhase1Entry {
  toolId: string;
  name: string;
  description: string;
  /** Cosine similarity from the embedding pass (-1..1, higher is better). */
  score: number;
}

/** Entry shown in the "relevant tools" bubble for phase-2 (LLM) and the
 *  always-available bypass. The score is absent because phase-2 picks
 *  candidates by relevance heuristic, not similarity. */
export interface ToolFilterEntry {
  toolId: string;
  name: string;
  description: string;
}

export type ServerToClientFrame =
  | { kind: "pong" }
  // Chat stream events
  | {
    kind: "chat.toolfilter";
    streamId: string;
    status: "filtering" | "complete" | "error";
    phase1?: ToolFilterPhase1Entry[];
    phase2?: ToolFilterEntry[];
    alwaysAvailable?: ToolFilterEntry[];
    errorMessage?: string;
  }
  | {
    kind: "chat.chunk";
    streamId: string;
    contentDelta?: string;
    reasoningDelta?: string;
    finishReason?: string;
  }
  | {
    kind: "chat.toolcall_requested";
    streamId: string;
    calls: PendingToolCall[];
  }
  | { kind: "chat.usage"; streamId: string; tokenUsage: TokenUsage }
  | { kind: "chat.done"; streamId: string; reason: string }
  | { kind: "chat.error"; streamId: string; code: ErrorCode; message: string }
  // Tool-call events
  | {
    kind: "tool.progress";
    callId: string;
    progress: number;
    label?: string;
    description?: string;
  }
  | {
    kind: "tool.askuser_request";
    callId: string;
    requestId: string;
    questions: AskUserQuestion[];
  }
  | {
    kind: "tool.log";
    callId: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
  }
  | { kind: "tool.result"; callId: string; result: unknown }
  | { kind: "tool.error"; callId: string; error: string; code?: ErrorCode }
  | { kind: "tool.cancelled"; callId: string }
  // Toolkit install / lifecycle
  | {
    kind: "toolkit.install_log";
    jobId: string;
    id: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "toolkit.install_done";
    jobId: string;
    id: string;
    ok: boolean;
    code: number;
  }
  | { kind: "toolkit.snapshot" }
  // Downloads + sidecars
  | { kind: "downloads.snapshot"; items: DownloadEntry[] }
  | {
    kind: "sidecar.status";
    sidecar: SidecarSnapshot["kind"];
    status: SidecarSnapshot["status"];
    message?: string;
    // 0..1 during model load / download phases. Drives the progress chip
    // next to the sidecar name in the Settings sidebar. Absent when the
    // sidecar has no observable progress (e.g. while running).
    progress?: number;
  }
  // Session sync (e.g. title generated server-side, assistant message persisted)
  | {
    kind: "session.updated";
    sessionId: string;
    op:
      | "title_changed"
      | "message_added"
      | "message_updated"
      | "message_deleted";
    payload?: {
      title?: string;
      messageId?: string;
      message?: unknown;
      toolCall?: ToolCall;
      attachments?: AttachmentRef[];
    };
  }
  // Self-update
  | { kind: "update.staged"; version: string }
  | { kind: "update.error"; code: ErrorCode; message: string };

export type WsFrame = ClientToServerFrame | ServerToClientFrame;
