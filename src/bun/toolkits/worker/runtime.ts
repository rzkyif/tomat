/// <reference lib="webworker" />
// Runtime for each Bun Worker that hosts a single trusted toolkit.
//
// Lifecycle:
//   1. Pool posts `{kind:"boot", toolkitId, entryPath}`.
//      We dynamically import the toolkit module, read METADATA, and post
//      `{kind:"booted", metadata}` back. A failure posts `{kind:"boot_failed"}`
//      and the worker stays alive so the pool can terminate it cleanly.
//   2. Pool posts `{kind:"call", callId, fnExport, ...}`.
//      We synthesize a ToolContext that relays setProgress/askUser/log back
//      over the same port, invoke the function, and post the result.
//   3. Multiple concurrent calls are supported - each gets its own
//      AbortController + pending askUser promise.

import type {
  AskUserAnswer,
  AskUserQuestion,
  PoolToWorkerFrame,
  WorkerToPoolFrame,
  ToolkitMetadata,
} from "../types";

declare const self: DedicatedWorkerGlobalScope;

type LogLevel = "debug" | "info" | "warn" | "error";

interface InternalToolContext {
  setProgress(progress: number, label?: string, description?: string): void;
  askUser(questions: AskUserQuestion[]): Promise<AskUserAnswer[]>;
  log(level: LogLevel, message: string): void;
  signal: AbortSignal;
  getChatContext(): { userMessage: string; sessionId: string | null; locale?: string };
}

let toolkitMod: Record<string, unknown> | null = null;
let toolkitId = "";
let toolkitEntryPath = "";

interface ActiveCall {
  ctrl: AbortController;
  pendingAskUser: Map<
    string,
    {
      resolve: (answers: AskUserAnswer[]) => void;
      reject: (err: Error) => void;
    }
  >;
}

const active = new Map<string, ActiveCall>();

function post(frame: WorkerToPoolFrame): void {
  self.postMessage(frame);
}

function randomId(): string {
  // crypto.randomUUID exists on Bun's Worker global (Web Crypto parity).
  // Fall back to a time+random string only if it's somehow missing - this
  // keeps collision probability vanishing even under pathological high
  // askUser volume.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

self.onmessage = async (ev: MessageEvent<PoolToWorkerFrame>) => {
  const msg = ev.data;
  try {
    switch (msg.kind) {
      case "boot":
        await handleBoot(msg.toolkitId, msg.entryPath);
        break;
      case "call":
        void handleCall(msg);
        break;
      case "cancel":
        handleCancel(msg.callId);
        break;
      case "ask_user_response":
        handleAskUserResponse(msg.callId, msg.requestId, msg.answers);
        break;
      case "shutdown":
        self.close();
        break;
    }
  } catch (err) {
    console.error("[toolkits/worker/runtime] top-level error:", err);
  }
};

async function handleBoot(id: string, entryPath: string): Promise<void> {
  toolkitId = id;
  toolkitEntryPath = entryPath;
  try {
    const mod = (await import(entryPath)) as Record<string, unknown>;
    const metadata = mod.METADATA as ToolkitMetadata | undefined;
    if (!metadata || typeof metadata !== "object") {
      throw new Error("toolkit does not export METADATA");
    }
    if (!Array.isArray(metadata.tools)) {
      throw new Error("METADATA.tools must be an array");
    }
    toolkitMod = mod;
    post({ kind: "booted", toolkitId: id, metadata });
  } catch (err) {
    post({
      kind: "boot_failed",
      toolkitId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleCall(msg: {
  callId: string;
  toolName: string;
  fnExport: string;
  arguments: string;
  chatContext: { userMessage: string; sessionId: string | null; locale?: string };
}): Promise<void> {
  if (!toolkitMod) {
    post({
      kind: "tool_error",
      callId: msg.callId,
      error: "toolkit module is not loaded",
    });
    return;
  }

  const fn = toolkitMod[msg.fnExport];
  if (typeof fn !== "function") {
    post({
      kind: "tool_error",
      callId: msg.callId,
      error: `toolkit does not export function "${msg.fnExport}"`,
    });
    return;
  }

  let parsedArgs: Record<string, unknown> = {};
  if (msg.arguments) {
    try {
      const parsed = JSON.parse(msg.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedArgs = parsed as Record<string, unknown>;
      }
    } catch {
      // keep empty - many small models produce truncated JSON; the tool can
      // surface the issue itself if it needs strict args.
    }
  }

  const ctrl = new AbortController();
  const entry: ActiveCall = { ctrl, pendingAskUser: new Map() };
  active.set(msg.callId, entry);

  const ctx: InternalToolContext = {
    setProgress(progress, label, description) {
      const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
      post({
        kind: "progress",
        callId: msg.callId,
        progress: clamped,
        label,
        description,
      });
    },
    askUser(questions) {
      return new Promise<AskUserAnswer[]>((resolve, reject) => {
        if (ctrl.signal.aborted) {
          reject(new Error("tool call cancelled"));
          return;
        }
        const requestId = randomId();
        entry.pendingAskUser.set(requestId, { resolve, reject });
        post({
          kind: "ask_user_request",
          callId: msg.callId,
          requestId,
          questions,
        });
      });
    },
    log(level, message) {
      post({ kind: "log", callId: msg.callId, level, message });
    },
    signal: ctrl.signal,
    getChatContext() {
      return {
        userMessage: msg.chatContext.userMessage,
        sessionId: msg.chatContext.sessionId,
        locale: msg.chatContext.locale,
      };
    },
  };

  try {
    const result = await (fn as (a: unknown, c: unknown) => Promise<unknown>)(parsedArgs, ctx);
    post({ kind: "tool_result", callId: msg.callId, result: result ?? null });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    post({ kind: "tool_error", callId: msg.callId, error: errMsg });
  } finally {
    active.delete(msg.callId);
    // Reject any still-pending askUser calls so the tool function doesn't
    // stay suspended if it raced with cancellation.
    for (const p of entry.pendingAskUser.values()) {
      try {
        p.reject(new Error("tool call ended"));
      } catch {
        /* ignore */
      }
    }
  }
}

function handleCancel(callId: string): void {
  const entry = active.get(callId);
  if (!entry) return;
  entry.ctrl.abort();
  for (const p of entry.pendingAskUser.values()) {
    p.reject(new Error("tool call cancelled"));
  }
  entry.pendingAskUser.clear();
}

function handleAskUserResponse(callId: string, requestId: string, answers: AskUserAnswer[]): void {
  const entry = active.get(callId);
  if (!entry) return;
  const pending = entry.pendingAskUser.get(requestId);
  if (!pending) return;
  entry.pendingAskUser.delete(requestId);
  pending.resolve(answers);
}

// Expose metadata so the sidecar can sanity-check bookkeeping if needed.
export { toolkitId, toolkitEntryPath };
