// NDJSON frames between the worker pool and a tool worker subprocess.
// Mirrors the shape used today by the Bun sidecar (src/bun/toolkits/types.ts)
// with one addition: stderr_log, so the worker can surface stderr text the
// pool will forward to its log subscribers.

export type AskUserAnswer = string | string[];

export interface AskUserQuestion {
  question: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  multiselect?: boolean;
  allowFreeformInput?: boolean;
}

export interface ChatContext {
  userMessage: string;
  sessionId: string | null;
  locale?: string;
}

export type PoolToWorkerFrame =
  | { kind: "boot"; toolkitId: string; entryPath: string }
  | {
    kind: "call";
    callId: string;
    toolName: string;
    fnExport: string;
    arguments: string;
    chatContext: ChatContext;
  }
  | { kind: "cancel"; callId: string }
  | {
    kind: "ask_user_response";
    callId: string;
    requestId: string;
    answers: AskUserAnswer[];
  }
  | { kind: "shutdown" };

export type WorkerToPoolFrame =
  | { kind: "ready" }
  | { kind: "booted"; toolkitId: string }
  | { kind: "boot_failed"; toolkitId: string; error: string }
  | {
    kind: "progress";
    callId: string;
    progress: number;
    label?: string;
    description?: string;
  }
  | {
    kind: "ask_user_request";
    callId: string;
    requestId: string;
    questions: AskUserQuestion[];
  }
  | {
    kind: "log";
    callId: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
  }
  | { kind: "tool_result"; callId: string; result: unknown }
  | { kind: "tool_error"; callId: string; error: string }
  | { kind: "stderr_log"; line: string };
