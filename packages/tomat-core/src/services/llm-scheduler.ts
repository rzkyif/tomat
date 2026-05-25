// LLM concurrency scheduler (plan §3).
//
// For local llama-server: at most parallelSlots concurrent in-flight
// completions; queued work picks per-client round-robin so a single client
// can't monopolize the model. Queue depth > parallelSlots * 4 returns
// server_busy immediately.
//
// External providers (OpenAI etc.) bypass the semaphore entirely — they
// enforce their own rate limits, and queueing locally would just add
// latency without protecting anything.

import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import {
  type LlmDelta,
  type LlmRequest,
  streamChatCompletion,
} from "./llm-provider.ts";

const log = getLogger("llm-scheduler");

const DEFAULT_PARALLEL_SLOTS = 4;
const QUEUE_DEPTH_MULTIPLIER = 4;

// Per the plan §3 watchdog: "if a slot exceeds callTimeoutMs + 60 s, abort
// upstream, mark llama-server unhealthy, restart". We can't replay queued
// requests at this layer (the stream is owned by services/chat.ts), but
// we abort the wedged upstream and trigger a restart so subsequent
// requests get a healthy server.
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const WATCHDOG_GRACE_MS = 60_000;

export interface ScheduleOptions {
  clientId: string;
  // Whether the upstream is the local llama-server (subject to semaphore)
  // or an external provider (bypassed).
  isLocal: boolean;
  // How many concurrent local completions the llama-server is configured for.
  // Equal to `--parallel N` on the llama-server command line.
  parallelSlots?: number;
}

export type WatchdogHandler = (info: {
  clientId: string;
  elapsedMs: number;
}) => void;

export class LlmScheduler {
  private localActive = 0;
  private localQueueByClient = new Map<string, Array<() => void>>();
  private clientOrder: string[] = [];
  private nextClientIdx = 0;
  private parallelSlots = DEFAULT_PARALLEL_SLOTS;
  private callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  private watchdogHandler: WatchdogHandler | null = null;

  setParallelSlots(n: number): void {
    if (!Number.isInteger(n) || n < 1) {
      throw new AppError("validation_error", `invalid parallelSlots: ${n}`);
    }
    this.parallelSlots = n;
  }

  setCallTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 1_000) {
      throw new AppError("validation_error", `invalid callTimeoutMs: ${ms}`);
    }
    this.callTimeoutMs = ms;
  }

  // Wire a callback the scheduler invokes when a local slot stays held
  // past `callTimeoutMs + WATCHDOG_GRACE_MS`. Typical handler: restart the
  // llama-server sidecar. The scheduler itself only aborts the upstream
  // stream and releases the slot — restart logic lives in the supervisor.
  setWatchdogHandler(fn: WatchdogHandler | null): void {
    this.watchdogHandler = fn;
  }

  private maxQueueDepth(): number {
    return this.parallelSlots * QUEUE_DEPTH_MULTIPLIER;
  }

  private queueLen(): number {
    let n = 0;
    for (const q of this.localQueueByClient.values()) n += q.length;
    return n;
  }

  // Streams a chat completion through the scheduler. Yields the same
  // LlmDelta sequence as streamChatCompletion, with semaphore acquisition
  // gating local provider work.
  async *schedule(
    req: LlmRequest,
    opts: ScheduleOptions,
  ): AsyncIterable<LlmDelta> {
    if (opts.isLocal) {
      if (opts.parallelSlots !== undefined) {
        this.setParallelSlots(opts.parallelSlots);
      }
      if (this.queueLen() >= this.maxQueueDepth()) {
        throw new AppError(
          "server_busy",
          `llama-server queue full (${this.queueLen()} waiting, ` +
            `${this.parallelSlots} slots)`,
        );
      }
      await this.acquireLocal(opts.clientId);
      // Combine the caller's abort signal (if any) with our watchdog
      // signal so an expired watchdog aborts the upstream cleanly.
      const watchdogController = new AbortController();
      const combinedSignal = req.signal
        ? AbortSignal.any([req.signal, watchdogController.signal])
        : watchdogController.signal;
      const wrappedReq: LlmRequest = { ...req, signal: combinedSignal };
      const startedAt = Date.now();
      const watchdogTimeoutMs = this.callTimeoutMs + WATCHDOG_GRACE_MS;
      const watchdogTimer = setTimeout(() => {
        log.error(
          `watchdog: local slot held ${watchdogTimeoutMs}ms by client ` +
            `${opts.clientId}; aborting upstream`,
        );
        try {
          watchdogController.abort(
            new AppError(
              "internal_error",
              `llm scheduler watchdog timeout after ${watchdogTimeoutMs}ms`,
            ),
          );
        } catch { /* signal already aborted */ }
        try {
          this.watchdogHandler?.({
            clientId: opts.clientId,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (err) {
          log.warn(
            `watchdog handler threw: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }, watchdogTimeoutMs);
      try {
        yield* streamChatCompletion(wrappedReq);
      } finally {
        clearTimeout(watchdogTimer);
        this.releaseLocal();
      }
      return;
    }
    // External provider path: no local concurrency control.
    yield* streamChatCompletion(req);
  }

  // --- local semaphore + round-robin ---------------------------------------

  private acquireLocal(clientId: string): Promise<void> {
    if (this.localActive < this.parallelSlots) {
      this.localActive++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let q = this.localQueueByClient.get(clientId);
      if (!q) {
        q = [];
        this.localQueueByClient.set(clientId, q);
        this.clientOrder.push(clientId);
      }
      q.push(() => {
        this.localActive++;
        resolve();
      });
    });
  }

  private releaseLocal(): void {
    this.localActive--;
    this.dispatch();
  }

  private dispatch(): void {
    if (this.clientOrder.length === 0) return;
    if (this.localActive >= this.parallelSlots) return;
    const startIdx = this.nextClientIdx % this.clientOrder.length;
    for (let i = 0; i < this.clientOrder.length; i++) {
      const idx = (startIdx + i) % this.clientOrder.length;
      const clientId = this.clientOrder[idx];
      const q = this.localQueueByClient.get(clientId);
      if (q && q.length > 0) {
        const next = q.shift();
        if (q.length === 0) {
          this.localQueueByClient.delete(clientId);
          this.clientOrder.splice(idx, 1);
          this.nextClientIdx = idx; // keep rotation point stable after splice
        } else {
          this.nextClientIdx = idx + 1;
        }
        next?.();
        return;
      }
    }
  }
}

let _instance: LlmScheduler | null = null;
export function llmScheduler(): LlmScheduler {
  if (!_instance) _instance = new LlmScheduler();
  return _instance;
}

// Test-only: drops the cached scheduler so the next `llmScheduler()` call
// rebuilds it with a fresh queue.
export function __resetForTesting(): void {
  _instance = null;
}

// Suppress unused-import warning in build output.
void log;
