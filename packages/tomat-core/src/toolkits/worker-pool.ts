// Toolkit worker pool. Per-toolkit warm subprocess with LRU eviction +
// idle timeout. Spawn flags are computed from the union of granted
// permissions across the toolkit's currently-enabled tools.
//
// Behaviorally rich part of the toolkit subsystem; ports the semantics of
// src/bun/toolkits/worker/pool.ts to per-toolkit Deno subprocesses.

import type {
  AskUserAnswer,
  AskUserQuestion,
  ChatContext,
} from "./worker-protocol.ts";
import type { Tool } from "@tomat/shared";
import { newCallId } from "../shared/ids.ts";
import { getLogger } from "../shared/log.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import {
  emptyFlagSet,
  flagSetToArgs,
  type PathTemplates,
  unionFlags,
} from "./permissions.ts";
import { toolkitsRegistry } from "./registry.ts";
import { WorkerHandle } from "./worker-handle.ts";

const log = getLogger("workerpool");

export interface PoolConfig {
  maxWarmWorkers: number;
  workerIdleMs: number;
  callTimeoutMs: number;
  drainTimeoutMs: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxWarmWorkers: 8,
  workerIdleMs: 300_000,
  callTimeoutMs: 60_000,
  drainTimeoutMs: 2_000,
};

export interface ToolCallStart {
  toolkitId: string;
  tool: Tool;
  // toolsJson-declared required permissions for this tool (must already
  // be granted; otherwise callers should 412 before reaching the pool).
  required: import("@tomat/shared").PermissionDecl[];
  argumentsJson: string;
  chatContext: ChatContext;
}

export type CallEvent =
  | {
    kind: "progress";
    progress: number;
    label?: string;
    description?: string;
  }
  | {
    kind: "ask_user_request";
    requestId: string;
    questions: AskUserQuestion[];
  }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  | { kind: "stderr_log"; line: string }
  // Emitted synchronously when cancel() is invoked so the UI's ToolCall
  // bubble can transition to the "cancelled" terminal state. The promise
  // returned by startCall still rejects with AppError("tool call cancelled")
  // after the worker acks; consumers that only care about the UX bubble
  // can stop here.
  | { kind: "tool_cancelled" };

export interface CallController {
  callId: string;
  // Reject the underlying askUser promise + emit tool_error.
  cancel(): void;
  // Forward the user's answer back to the worker.
  respondAskUser(requestId: string, answers: AskUserAnswer[]): void;
  // Settle when the worker emits tool_result / tool_error.
  done: Promise<unknown>;
}

export class WorkerPool {
  private config: PoolConfig = DEFAULT_POOL_CONFIG;
  private workers = new Map<string, WorkerHandle>();
  private lru: string[] = []; // toolkitIds in MRU order
  private idleTimers = new Map<string, number>();

  setConfig(cfg: Partial<PoolConfig>): void {
    this.config = { ...this.config, ...cfg };
  }

  // Execute a single tool call. Returns a controller for cancel/askUser
  // forwarding; the `done` promise settles with the tool's return value
  // (resolved on tool_result) or rejects on tool_error / cancel / timeout.
  startCall(
    spec: ToolCallStart,
    onEvent: (event: CallEvent) => void,
  ): CallController {
    const callId = newCallId();
    const worker = this.getOrSpawn(spec);

    let timeout: number | undefined;
    let cancelled = false;
    let askUserPending = false;
    // Tracks how much of the callTimeoutMs budget is still available so
    // askUser can pause + resume the timer (instead of resetting it).
    let timeoutBudgetMs = this.config.callTimeoutMs;
    let timeoutArmedAt: number | undefined;

    // Outer closures so cancel/respondAskUser can drive them.
    let rejectDone: (err: Error) => void = () => {};
    let offHandler: () => void = () => {};

    const done = new Promise<unknown>((resolve, reject) => {
      rejectDone = reject;
      const off = worker.on((frame) => {
        if (
          (frame as { callId?: string }).callId !== undefined &&
          (frame as { callId: string }).callId !== callId &&
          frame.kind !== "stderr_log"
        ) {
          return;
        }
        switch (frame.kind) {
          case "progress":
            onEvent({
              kind: "progress",
              progress: frame.progress,
              label: frame.label,
              description: frame.description,
            });
            return;
          case "ask_user_request":
            askUserPending = true;
            // Pause the budget: subtract the time we've already consumed,
            // then disarm so the timer can be re-armed on response.
            pauseTimeout();
            onEvent({
              kind: "ask_user_request",
              requestId: frame.requestId,
              questions: frame.questions,
            });
            return;
          case "log":
            onEvent({
              kind: "log",
              level: frame.level,
              message: frame.message,
            });
            return;
          case "stderr_log":
            onEvent({ kind: "stderr_log", line: frame.line });
            return;
          case "tool_result":
            off();
            disarm();
            worker.inFlightCalls--;
            this.bumpIdleTimer(spec.toolkitId);
            resolve(frame.result);
            return;
          case "tool_error":
            off();
            disarm();
            worker.inFlightCalls--;
            this.bumpIdleTimer(spec.toolkitId);
            // If we already emitted tool_cancelled, the consumer has moved
            // on; the worker's late tool_error is just bookkeeping. Reject
            // with the same "cancelled" message so callers waiting on
            // `done` see a consistent error class.
            if (cancelled) {
              reject(new AppError("internal_error", "tool call cancelled"));
            } else {
              reject(new AppError("provider_error", frame.error));
            }
            return;
        }
      });
      offHandler = off;

      worker.waitForBoot().then(() => {
        if (cancelled) {
          off();
          reject(new AppError("internal_error", "cancelled before boot"));
          return;
        }
        worker.inFlightCalls++;
        this.clearIdleTimer(spec.toolkitId);
        worker.send({
          kind: "call",
          callId,
          toolName: spec.tool.name,
          fnExport: spec.tool.fnExport,
          arguments: spec.argumentsJson,
          chatContext: spec.chatContext,
        });
        armTimeout();
      }).catch((err) => {
        // Worker boot failed → synthesize a tool_error event so the UI
        // doesn't hang in "running", then reject `done` so the caller's
        // catch path runs. Without the synthetic event the chat-side
        // ToolCall bubble would never reach a terminal state.
        off();
        worker.inFlightCalls = Math.max(0, worker.inFlightCalls - 1);
        this.bumpIdleTimer(spec.toolkitId);
        const msg = err instanceof Error ? err.message : String(err);
        try {
          onEvent({
            kind: "log",
            level: "error",
            message: `worker boot failed: ${msg}`,
          });
        } catch { /* listener errors are non-fatal here */ }
        reject(
          err instanceof Error
            ? err
            : new AppError("internal_error", `worker boot failed: ${msg}`),
        );
      });
    });

    const armTimeout = () => {
      if (timeoutBudgetMs <= 0 || cancelled) return;
      timeoutArmedAt = Date.now();
      timeout = setTimeout(() => {
        if (askUserPending) return;
        // Bookkeeping must run even if the worker is already dead and
        // `send` throws — otherwise the listener leaks and `done` hangs.
        try {
          worker.send({ kind: "cancel", callId });
        } catch { /* worker is gone; cancel is moot */ }
        offHandler();
        worker.inFlightCalls--;
        this.bumpIdleTimer(spec.toolkitId);
        rejectDone(new AppError("internal_error", "tool call timed out"));
      }, timeoutBudgetMs);
    };

    const pauseTimeout = () => {
      if (timeout === undefined || timeoutArmedAt === undefined) return;
      const elapsed = Date.now() - timeoutArmedAt;
      timeoutBudgetMs = Math.max(0, timeoutBudgetMs - elapsed);
      clearTimeout(timeout);
      timeout = undefined;
      timeoutArmedAt = undefined;
    };

    const disarm = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
        timeoutArmedAt = undefined;
      }
    };

    return {
      callId,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // UI bubble transitions to cancelled immediately; the actual
        // worker abort + done-rejection happens via the worker's
        // tool_error frame (or the worker exits before then).
        try {
          onEvent({ kind: "tool_cancelled" });
        } catch { /* listener errors are non-fatal here */ }
        worker.send({ kind: "cancel", callId });
        disarm();
      },
      respondAskUser: (requestId, answers) => {
        askUserPending = false;
        worker.send({
          kind: "ask_user_response",
          callId,
          requestId,
          answers,
        });
        // Resume the timer with the REMAINING budget instead of a fresh
        // callTimeoutMs window. Slow user answers shouldn't extend the
        // tool's effective time budget.
        if (timeout === undefined && !cancelled) {
          armTimeout();
        }
      },
      done,
    };
  }

  // Kill the warm worker for `toolkitId` (e.g. after a grant change). Any
  // in-flight calls receive tool_error("permissions_revoked") via the
  // worker's exit -> rejection path.
  async refreshPermissions(toolkitId: string): Promise<void> {
    const w = this.workers.get(toolkitId);
    if (!w) return;
    log.info(`refreshPermissions: terminating warm worker for ${toolkitId}`);
    await w.terminate(this.config.drainTimeoutMs);
    this.workers.delete(toolkitId);
    this.removeFromLru(toolkitId);
    this.clearIdleTimer(toolkitId);
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(
        this.workers.values(),
        (w) => w.terminate(this.config.drainTimeoutMs),
      ),
    );
    this.workers.clear();
    this.lru = [];
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
  }

  stats(): {
    warmWorkers: number;
    maxWarmWorkers: number;
    inFlightCalls: number;
  } {
    let total = 0;
    for (const w of this.workers.values()) total += w.inFlightCalls;
    return {
      warmWorkers: this.workers.size,
      maxWarmWorkers: this.config.maxWarmWorkers,
      inFlightCalls: total,
    };
  }

  // --- internals ---------------------------------------------------------

  private getOrSpawn(spec: ToolCallStart): WorkerHandle {
    const existing = this.workers.get(spec.toolkitId);
    if (existing) {
      this.touchLru(spec.toolkitId);
      return existing;
    }
    if (this.workers.size >= this.config.maxWarmWorkers) {
      if (!this.evictLeastRecent()) {
        throw new AppError(
          "server_busy",
          `all ${this.config.maxWarmWorkers} warm toolkit workers are busy; retry after a tool call drains`,
        );
      }
    }
    return this.spawn(spec);
  }

  private spawn(spec: ToolCallStart): WorkerHandle {
    const toolkit = toolkitsRegistry().getOrThrow(spec.toolkitId);
    const enabledTools = toolkitsRegistry().listTools(spec.toolkitId).filter((
      t,
    ) => t.enabled);
    // Each enabled tool contributes its OWN persisted required permissions;
    // the union over enabled tools' granted entries becomes the worker's
    // --allow-* flag set.
    const tools = enabledTools.map((t) => ({
      required: t.requiredPermissions,
      grants: t.grants,
    }));
    void spec.required; // retained on ToolCallStart for back-compat; not used here
    const templates: PathTemplates = {
      home: Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "",
      downloads: defaultDownloadsDir(),
      models: paths().modelsDir,
      sessions: paths().sessionsDir,
      toolkit: toolkit.installedPath,
    };
    const flags = flagSetToArgs(
      tools.length > 0 ? unionFlags(tools, templates) : emptyFlagSet(),
    );

    const w = WorkerHandle.spawn({
      toolkitId: spec.toolkitId,
      entryPath: resolveEntryPath(toolkit.installedPath),
      toolkitFolder: toolkit.installedPath,
      flags,
    });
    this.workers.set(spec.toolkitId, w);
    this.touchLru(spec.toolkitId);
    return w;
  }

  private evictLeastRecent(): boolean {
    // Walk LRU head-to-tail (oldest first) and evict the first idle worker.
    // In-flight workers are skipped without disturbing LRU order; if every
    // worker is busy, returns false so the caller can refuse the spawn
    // instead of silently exceeding maxWarmWorkers.
    for (const id of this.lru) {
      const w = this.workers.get(id);
      if (!w || w.inFlightCalls > 0) continue;
      log.info(`evicting idle worker for ${id}`);
      void w.terminate(this.config.drainTimeoutMs);
      this.workers.delete(id);
      this.removeFromLru(id);
      this.clearIdleTimer(id);
      return true;
    }
    return false;
  }

  private touchLru(toolkitId: string): void {
    this.removeFromLru(toolkitId);
    this.lru.push(toolkitId);
  }
  private removeFromLru(toolkitId: string): void {
    const i = this.lru.indexOf(toolkitId);
    if (i !== -1) this.lru.splice(i, 1);
  }

  private bumpIdleTimer(toolkitId: string): void {
    this.clearIdleTimer(toolkitId);
    const w = this.workers.get(toolkitId);
    if (!w) return;
    if (w.inFlightCalls > 0) return;
    const t = setTimeout(() => {
      log.info(`idle eviction for ${toolkitId}`);
      void w.terminate(this.config.drainTimeoutMs);
      this.workers.delete(toolkitId);
      this.removeFromLru(toolkitId);
      this.idleTimers.delete(toolkitId);
    }, this.config.workerIdleMs);
    this.idleTimers.set(toolkitId, t as unknown as number);
  }
  private clearIdleTimer(toolkitId: string): void {
    const t = this.idleTimers.get(toolkitId);
    if (t !== undefined) {
      clearTimeout(t);
      this.idleTimers.delete(toolkitId);
    }
  }
}

let _instance: WorkerPool | null = null;
export function workerPool(): WorkerPool {
  if (!_instance) _instance = new WorkerPool();
  return _instance;
}

export function __resetForTesting(): void {
  _instance = null;
}

function resolveEntryPath(toolkitFolder: string): string {
  // Default to index.ts / index.js / package.json main. Worker uses
  // dynamic import("file://..."), so we just point at the file Deno's
  // module resolver should treat as the entry. For npm-extracted toolkits
  // the package.json "main" field is the most reliable; for local toolkits
  // we fall back to index.ts.
  // Caller resolution defers to a simple convention here; richer logic can
  // be added later if needed.
  try {
    const pkgPath = `${toolkitFolder}/package.json`;
    const text = Deno.readTextFileSync(pkgPath);
    const pkg = JSON.parse(text) as { main?: string; exports?: unknown };
    if (typeof pkg.main === "string" && pkg.main.length > 0) {
      return `${toolkitFolder}/${pkg.main.replace(/^\.\//, "")}`;
    }
  } catch { /* no package.json */ }
  return `${toolkitFolder}/index.ts`;
}

function defaultDownloadsDir(): string {
  if (Deno.build.os === "windows") {
    const profile = Deno.env.get("USERPROFILE");
    if (profile) return `${profile}\\Downloads`;
    return "";
  }
  const home = Deno.env.get("HOME");
  return home ? `${home}/Downloads` : "";
}
