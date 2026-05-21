// Tool worker subprocess (one per enabled toolkit).
// Spawned by toolkits/workerHandle.ts with exactly the --allow-* flags
// derived from the toolkit's enabled tools' granted permissions.
//
// CLI:
//   deno run [flags] toolWorker.ts --toolkit-id=<id> --entry=<absPath>
//
// Protocol: NDJSON on stdio (see toolkits/workerProtocol.ts).

import type {
  AskUserAnswer,
  AskUserQuestion,
  PoolToWorkerFrame,
  WorkerToPoolFrame,
} from "../toolkits/workerProtocol.ts";

type ToolContext = {
  setProgress(progress: number, label?: string, description?: string): void;
  askUser(questions: AskUserQuestion[]): Promise<AskUserAnswer[]>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  signal: AbortSignal;
  getChatContext(): {
    userMessage: string;
    sessionId: string | null;
    locale?: string;
  };
};

type ToolFn = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

interface CallState {
  abort: AbortController;
  chatContext: {
    userMessage: string;
    sessionId: string | null;
    locale?: string;
  };
  pendingAskUser: Map<string, {
    resolve: (a: AskUserAnswer[]) => void;
    reject: (e: Error) => void;
  }>;
}

const calls = new Map<string, CallState>();
let toolkitMod: Record<string, unknown> | null = null;
let _toolkitId = "";

function send(frame: WorkerToPoolFrame): void {
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
}

async function handleBoot(toolkit: string, entry: string): Promise<void> {
  _toolkitId = toolkit;
  try {
    toolkitMod = await import("file://" + entry);
    send({ kind: "booted", toolkitId: toolkit });
  } catch (err) {
    send({
      kind: "boot_failed",
      toolkitId: toolkit,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleCall(
  frame: Extract<PoolToWorkerFrame, { kind: "call" }>,
): Promise<void> {
  if (!toolkitMod) {
    send({
      kind: "tool_error",
      callId: frame.callId,
      error: "worker not booted",
    });
    return;
  }
  const fn = toolkitMod[frame.fnExport] as ToolFn | undefined;
  if (typeof fn !== "function") {
    send({
      kind: "tool_error",
      callId: frame.callId,
      error: `no export "${frame.fnExport}"`,
    });
    return;
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(frame.arguments);
    if (!args || typeof args !== "object") {
      throw new Error("arguments must be an object");
    }
  } catch (err) {
    send({
      kind: "tool_error",
      callId: frame.callId,
      error: `invalid arguments JSON: ${
        err instanceof Error ? err.message : err
      }`,
    });
    return;
  }
  const state: CallState = {
    abort: new AbortController(),
    chatContext: frame.chatContext,
    pendingAskUser: new Map(),
  };
  calls.set(frame.callId, state);

  const ctx: ToolContext = {
    setProgress(progress, label, description) {
      send({
        kind: "progress",
        callId: frame.callId,
        progress: Math.max(0, Math.min(1, progress)),
        label,
        description,
      });
    },
    askUser(questions) {
      const requestId = crypto.randomUUID();
      send({
        kind: "ask_user_request",
        callId: frame.callId,
        requestId,
        questions,
      });
      return new Promise<AskUserAnswer[]>((resolve, reject) => {
        state.pendingAskUser.set(requestId, { resolve, reject });
      });
    },
    log(level, message) {
      send({ kind: "log", callId: frame.callId, level, message });
    },
    signal: state.abort.signal,
    getChatContext() {
      return state.chatContext;
    },
  };

  try {
    const result = await fn(args, ctx);
    send({ kind: "tool_result", callId: frame.callId, result });
  } catch (err) {
    send({
      kind: "tool_error",
      callId: frame.callId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    calls.delete(frame.callId);
  }
}

function handleCancel(callId: string): void {
  const state = calls.get(callId);
  if (!state) return;
  state.abort.abort();
  for (const p of state.pendingAskUser.values()) {
    p.reject(new Error("User interrupted"));
  }
  state.pendingAskUser.clear();
}

function handleAskUserResponse(
  callId: string,
  requestId: string,
  answers: AskUserAnswer[],
): void {
  const state = calls.get(callId);
  if (!state) return;
  const p = state.pendingAskUser.get(requestId);
  if (!p) return;
  state.pendingAskUser.delete(requestId);
  p.resolve(answers);
}

function parseArgs(): { toolkitId: string; entry: string } {
  let toolkitId = "";
  let entry = "";
  for (const arg of Deno.args) {
    if (arg.startsWith("--toolkit-id=")) {
      toolkitId = arg.slice("--toolkit-id=".length);
    } else if (arg.startsWith("--entry=")) entry = arg.slice("--entry=".length);
  }
  if (!toolkitId || !entry) {
    Deno.stderr.writeSync(
      new TextEncoder().encode("missing --toolkit-id / --entry\n"),
    );
    Deno.exit(1);
  }
  return { toolkitId, entry };
}

async function main(): Promise<void> {
  const args = parseArgs();
  // Boot frame is unsolicited: the pool sees ready -> sends boot. Send ready
  // first so the pool can start tracking.
  send({ kind: "ready" });
  await handleBoot(args.toolkitId, args.entry);

  const decoder = new TextDecoder();
  const reader = Deno.stdin.readable.getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: PoolToWorkerFrame;
      try {
        frame = JSON.parse(line) as PoolToWorkerFrame;
      } catch {
        send({ kind: "stderr_log", line: `bad frame: ${line}` });
        continue;
      }
      if (frame.kind === "call") void handleCall(frame);
      else if (frame.kind === "cancel") handleCancel(frame.callId);
      else if (frame.kind === "ask_user_response") {
        handleAskUserResponse(frame.callId, frame.requestId, frame.answers);
      } else if (frame.kind === "shutdown") {
        Deno.exit(0);
      } else if (frame.kind === "boot") {
        // Re-boot would be unusual but legal: drop the previous module and re-import.
        await handleBoot(frame.toolkitId, frame.entryPath);
      }
    }
  }
}

if (import.meta.main) {
  await main();
}
