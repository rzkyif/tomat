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
  // Synthesized by WorkerHandle (not the worker process) when a Deno
  // permission prompt on the worker's PTY needs the user's decision; the
  // pool forwards it to chat and answers via WorkerHandle.answerPrompt().
  // No callId: a prompt blocks the worker's whole JS thread. WorkerHandle
  // only emits this when exactly one call is in flight (it fails the prompt
  // closed otherwise), so the pool can attribute it to that call.
  | {
      kind: "permission_prompt";
      requestId: string;
      permission: import("@tomat/shared").PermissionKind;
      resource: string;
      apiName?: string;
      declared: boolean;
      reason?: string;
    }
  // Synthesized by WorkerHandle when the worker process exits. No callId: it
  // settles every in-flight call on the dead worker (crash, OOM, give-up kill,
  // or a refreshPermissions teardown) instead of leaving them to hang until
  // the pool's call timeout fires.
  | { kind: "worker_exited"; code: number }
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
