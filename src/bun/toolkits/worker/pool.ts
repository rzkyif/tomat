import type {
  AskUserAnswer,
  AskUserQuestion,
  PoolToWorkerFrame,
  ToolkitMetadata,
  WorkerToPoolFrame,
} from "../types";

export interface ToolCallEvent {
  callId: string;
  kind: "progress" | "ask_user_request" | "log" | "tool_result" | "tool_error";
  // Union of all shapes; frontend callers discriminate on `kind`.
  progress?: number;
  label?: string;
  description?: string;
  requestId?: string;
  questions?: AskUserQuestion[];
  level?: "debug" | "info" | "warn" | "error";
  message?: string;
  result?: unknown;
  error?: string;
}

export interface StartCallOptions {
  callId: string;
  toolkitId: string;
  toolName: string;
  fnExport: string;
  arguments: string;
  chatContext: { userMessage: string; sessionId: string | null; locale?: string };
  onEvent: (ev: ToolCallEvent) => void;
}

interface WorkerEntry {
  toolkitId: string;
  entryPath: string;
  worker: Worker;
  ready: Promise<void>;
  metadata: ToolkitMetadata | null;
  /** When the worker is idle (no in-flight calls), `idleTimer` is the
   *  pending termination handle. Cleared when a call starts. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Map<string, (ev: ToolCallEvent) => void>;
  /** Monotonic LRU clock; lower = older. */
  lastUsed: number;
}

export interface WorkerPoolOptions {
  workerScriptUrl: string | URL;
  maxWarmWorkers: number;
  workerIdleMs: number;
  /** Hard upper bound for a single tool call (ms). After this elapses the
   *  call is aborted and the caller receives a `tool_error`. Protects
   *  against stalled toolkit workers from hanging tool-call state
   *  indefinitely on the frontend. */
  callTimeoutMs: number;
  /** How long to wait for in-flight calls to finish before `.terminate()`
   *  forcibly tears the worker down. Gives a running tool a chance to emit
   *  its terminal frame on trust revocation / shutdown. */
  drainTimeoutMs: number;
}

/** Reasonable defaults for callers that don't provide these. Tuned so a
 *  genuinely long-running tool (file download, shell command) can finish
 *  while a hung tool is surfaced as an error within the minute. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

/** Host-side lifecycle + routing for per-toolkit Workers. */
export class WorkerPool {
  private workers = new Map<string, WorkerEntry>();
  private clock = 0;
  opts: WorkerPoolOptions;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
  }

  updateLimits(
    opts: Partial<
      Pick<
        WorkerPoolOptions,
        "maxWarmWorkers" | "workerIdleMs" | "callTimeoutMs" | "drainTimeoutMs"
      >
    >,
  ) {
    if (typeof opts.maxWarmWorkers === "number" && opts.maxWarmWorkers > 0) {
      this.opts.maxWarmWorkers = opts.maxWarmWorkers;
    }
    if (typeof opts.workerIdleMs === "number" && opts.workerIdleMs >= 0) {
      this.opts.workerIdleMs = opts.workerIdleMs;
    }
    if (typeof opts.callTimeoutMs === "number" && opts.callTimeoutMs > 0) {
      this.opts.callTimeoutMs = opts.callTimeoutMs;
    }
    if (typeof opts.drainTimeoutMs === "number" && opts.drainTimeoutMs >= 0) {
      this.opts.drainTimeoutMs = opts.drainTimeoutMs;
    }
    this.enforceMaxWorkers();
  }

  /** Accessor for the current in-flight count across all warm workers,
   *  used by `/api/health` to expose liveness. */
  stats(): { warmWorkers: number; maxWarmWorkers: number; inFlightCalls: number } {
    let inFlight = 0;
    for (const e of this.workers.values()) inFlight += e.inFlight.size;
    return {
      warmWorkers: this.workers.size,
      maxWarmWorkers: this.opts.maxWarmWorkers,
      inFlightCalls: inFlight,
    };
  }

  /** Spawn a worker + wait for boot. Safe to call when a warm worker already
   *  exists - reuses it and just re-verifies the entry path hasn't changed. */
  async ensureReady(toolkitId: string, entryPath: string): Promise<ToolkitMetadata> {
    let entry = this.workers.get(toolkitId);
    if (entry && entry.entryPath !== entryPath) {
      // Path changed (mtime bump or move). Start fresh.
      await this.terminate(toolkitId);
      entry = undefined;
    }
    if (!entry) {
      entry = this.spawn(toolkitId, entryPath);
    }
    await entry.ready;
    if (!entry.metadata) {
      throw new Error("toolkit did not produce METADATA");
    }
    return entry.metadata;
  }

  /** Run one tool call through the warm (or newly spawned) worker for this
   *  toolkit. `onEvent` receives every progress/log/ask_user/result/error
   *  frame for this `callId`. Resolves when a terminal (result/error) frame
   *  is seen. */
  async runCall(
    entryPath: string,
    opts: StartCallOptions,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const entry = await this.acquireEntry(opts.toolkitId, entryPath);
    this.clearIdleTimer(entry);
    entry.lastUsed = ++this.clock;
    entry.inFlight.set(opts.callId, opts.onEvent);

    return new Promise((resolve) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const settle = (outcome: { ok: boolean; result?: unknown; error?: string }) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        entry.inFlight.delete(opts.callId);
        this.scheduleIdleTimer(entry);
        resolve(outcome);
      };

      const forward = (ev: ToolCallEvent) => {
        opts.onEvent(ev);
        if (ev.kind === "tool_result") {
          settle({ ok: true, result: ev.result });
        } else if (ev.kind === "tool_error") {
          settle({ ok: false, error: ev.error });
        }
      };
      entry.inFlight.set(opts.callId, forward);

      if (this.opts.callTimeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          // Surface the timeout as a tool_error so the frontend's pending
          // state resolves, then ask the worker to cancel. If the worker is
          // cleanly abortable the cancel frame lands; if not, the next
          // runCall will observe a busy worker and terminate/respawn.
          const timeoutEvent: ToolCallEvent = {
            kind: "tool_error",
            callId: opts.callId,
            error: `tool call timed out after ${this.opts.callTimeoutMs}ms`,
          };
          try {
            opts.onEvent(timeoutEvent);
          } catch (err) {
            console.error("[toolkits/worker/pool] forwarding timeout event failed:", err);
          }
          this.cancelCall(entry.toolkitId, opts.callId);
          settle({ ok: false, error: timeoutEvent.error });
        }, this.opts.callTimeoutMs);
      }

      const frame: PoolToWorkerFrame = {
        kind: "call",
        callId: opts.callId,
        toolName: opts.toolName,
        fnExport: opts.fnExport,
        arguments: opts.arguments,
        chatContext: opts.chatContext,
      };
      entry.worker.postMessage(frame);
    });
  }

  sendAskUserResponse(
    toolkitId: string,
    callId: string,
    requestId: string,
    answers: AskUserAnswer[],
  ): void {
    const entry = this.workers.get(toolkitId);
    if (!entry) return;
    const frame: PoolToWorkerFrame = {
      kind: "ask_user_response",
      callId,
      requestId,
      answers,
    };
    entry.worker.postMessage(frame);
  }

  cancelCall(toolkitId: string, callId: string): void {
    const entry = this.workers.get(toolkitId);
    if (!entry) return;
    const frame: PoolToWorkerFrame = { kind: "cancel", callId };
    entry.worker.postMessage(frame);
  }

  async terminate(toolkitId: string): Promise<void> {
    const entry = this.workers.get(toolkitId);
    if (!entry) return;
    this.workers.delete(toolkitId);
    this.clearIdleTimer(entry);

    // If calls are mid-flight, give them a short drain window to emit a
    // terminal frame on their own before we forcibly kill the worker. Beyond
    // that window, any still-pending calls get a synthetic tool_error so
    // their frontend state unblocks, and we then terminate.
    if (entry.inFlight.size > 0 && this.opts.drainTimeoutMs > 0) {
      await this.drain(entry, this.opts.drainTimeoutMs);
    }

    for (const [callId, emit] of entry.inFlight) {
      try {
        emit({ kind: "tool_error", callId, error: "worker terminated" });
      } catch (err) {
        console.error("[toolkits/worker/pool] forwarding terminate error failed:", err);
      }
    }
    entry.inFlight.clear();
    try {
      entry.worker.terminate();
    } catch {
      /* ignore */
    }
  }

  /** Wait up to `timeoutMs` for `entry.inFlight` to naturally drain. Polls
   *  at a coarse interval. Tool calls that respect `cancel` frames usually
   *  finish in single-digit ms, so this rarely hits its ceiling. */
  private async drain(entry: WorkerEntry, timeoutMs: number): Promise<void> {
    // Proactively signal cancel so cooperative tools can abort quickly
    // rather than running to completion before replying.
    for (const callId of entry.inFlight.keys()) {
      const cancelFrame: PoolToWorkerFrame = { kind: "cancel", callId };
      try {
        entry.worker.postMessage(cancelFrame);
      } catch {
        /* worker may already be gone */
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (entry.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async terminateAll(): Promise<void> {
    const ids = Array.from(this.workers.keys());
    await Promise.all(ids.map((id) => this.terminate(id)));
  }

  private async acquireEntry(toolkitId: string, entryPath: string): Promise<WorkerEntry> {
    let entry = this.workers.get(toolkitId);
    if (!entry || entry.entryPath !== entryPath) {
      if (entry) await this.terminate(toolkitId);
      this.enforceMaxWorkers(toolkitId);
      entry = this.spawn(toolkitId, entryPath);
    }
    await entry.ready;
    return entry;
  }

  private enforceMaxWorkers(preservedId?: string): void {
    while (this.workers.size >= this.opts.maxWarmWorkers) {
      let victim: WorkerEntry | null = null;
      for (const e of this.workers.values()) {
        if (e.toolkitId === preservedId) continue;
        if (e.inFlight.size > 0) continue;
        if (!victim || e.lastUsed < victim.lastUsed) victim = e;
      }
      if (!victim) return; // all remaining workers are busy; can't evict
      void this.terminate(victim.toolkitId);
    }
  }

  private spawn(toolkitId: string, entryPath: string): WorkerEntry {
    const worker = new Worker(this.opts.workerScriptUrl.toString());
    const entry: WorkerEntry = {
      toolkitId,
      entryPath,
      worker,
      ready: Promise.resolve(),
      metadata: null,
      idleTimer: null,
      inFlight: new Map(),
      lastUsed: ++this.clock,
    };

    // Hoisted so the error/close listeners (set up below) can reject the
    // boot promise if the worker dies before sending `booted`/`boot_failed`.
    // Without this, a Worker constructor failure (bad script URL, syntax
    // error on the toolkit's top-level import, etc.) leaves `entry.ready`
    // pending forever and `ensureReady` hangs.
    let bootSettled = false;
    let rejectBoot: (err: Error) => void = () => {};

    const handleWorkerFailure = (reason: string) => {
      if (!bootSettled) {
        bootSettled = true;
        rejectBoot(new Error(reason));
      }
      const inflight = Array.from(entry.inFlight.entries());
      entry.inFlight.clear();
      for (const [callId, emit] of inflight) {
        try {
          emit({ kind: "tool_error", callId, error: `worker terminated: ${reason}` });
        } catch (err) {
          console.error("[toolkits/worker/pool] forwarding terminal error failed:", err);
        }
      }
      if (this.workers.get(toolkitId) === entry) {
        this.workers.delete(toolkitId);
        this.clearIdleTimer(entry);
      }
      try {
        entry.worker.terminate();
      } catch {
        /* worker may already be gone */
      }
    };

    worker.addEventListener("error", (e) => {
      const reason = (e as ErrorEvent).message || "unknown worker error";
      console.warn(`[toolkits/worker/pool] worker ${toolkitId} error:`, reason);
      handleWorkerFailure(reason);
    });
    // Bun's Worker also exposes "close" when the worker self-terminates
    // (e.g. via self.close() or an unhandled rejection in a top-level
    // handler). Treat it the same as error so lingering calls unblock.
    worker.addEventListener("close", () => {
      if (this.workers.get(toolkitId) !== entry) return;
      handleWorkerFailure("worker exited");
    });

    entry.ready = new Promise<void>((resolve, reject) => {
      rejectBoot = reject;
      const onMessage = (ev: MessageEvent<WorkerToPoolFrame>) => {
        const msg = ev.data;
        if (msg.kind === "booted") {
          bootSettled = true;
          entry.metadata = msg.metadata;
          worker.removeEventListener("message", onMessage);
          worker.addEventListener("message", (e) =>
            this.onWorkerMessage(entry, e as MessageEvent<WorkerToPoolFrame>),
          );
          resolve();
        } else if (msg.kind === "boot_failed") {
          bootSettled = true;
          worker.removeEventListener("message", onMessage);
          reject(new Error(msg.error));
          handleWorkerFailure(msg.error);
        }
      };
      worker.addEventListener("message", onMessage);
      const bootFrame: PoolToWorkerFrame = { kind: "boot", toolkitId, entryPath };
      worker.postMessage(bootFrame);
    });
    this.workers.set(toolkitId, entry);
    return entry;
  }

  private onWorkerMessage(entry: WorkerEntry, ev: MessageEvent<WorkerToPoolFrame>): void {
    const msg = ev.data;
    if (msg.kind === "booted" || msg.kind === "boot_failed") return;
    const emit = entry.inFlight.get(msg.callId);
    if (!emit) return;
    switch (msg.kind) {
      case "progress":
        emit({
          kind: "progress",
          callId: msg.callId,
          progress: msg.progress,
          label: msg.label,
          description: msg.description,
        });
        break;
      case "ask_user_request":
        emit({
          kind: "ask_user_request",
          callId: msg.callId,
          requestId: msg.requestId,
          questions: msg.questions,
        });
        break;
      case "log":
        emit({
          kind: "log",
          callId: msg.callId,
          level: msg.level,
          message: msg.message,
        });
        break;
      case "tool_result":
        emit({ kind: "tool_result", callId: msg.callId, result: msg.result });
        break;
      case "tool_error":
        emit({ kind: "tool_error", callId: msg.callId, error: msg.error });
        break;
    }
  }

  private scheduleIdleTimer(entry: WorkerEntry): void {
    if (entry.inFlight.size > 0) return;
    this.clearIdleTimer(entry);
    if (this.opts.workerIdleMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      // Idle termination: only fire if still idle when the timer pops.
      if (entry.inFlight.size > 0) return;
      void this.terminate(entry.toolkitId);
    }, this.opts.workerIdleMs);
  }

  private clearIdleTimer(entry: WorkerEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }
}
