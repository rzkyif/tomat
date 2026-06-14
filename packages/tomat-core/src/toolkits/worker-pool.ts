// Toolkit worker pool. Per-(toolkit, tool) warm subprocess with LRU eviction +
// idle timeout. Spawn flags are computed from ONLY the invoked tool's granted
// permissions (least privilege): a benign tool never runs in a process that
// holds a sibling tool's net / run / ffi grants.
//
// Behaviorally rich part of the toolkit subsystem; ports the semantics of
// src/bun/toolkits/worker/pool.ts to Deno subprocesses.

import type { AskUserAnswer, AskUserQuestion, ChatContext } from "./worker-protocol.ts";
import { askUserQuestionSchema, errMessage, scheduledPromptDraftSchema } from "@tomat/shared";
import type { DisplayContent, ScheduledPromptDraft, Tool } from "@tomat/shared";
import { handleModuleRequest, type ModulePrompt } from "../services/module-broker.ts";
import { newCallId } from "../shared/ids.ts";
import { getLogger, scrubSecrets } from "../shared/log.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { emptyFlagSet, flagSetToArgs, type PathTemplates, unionFlags } from "./permissions.ts";
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
  // The running tool hit a Deno permission prompt that needs the user's
  // decision (declared ask-state permission, or undeclared with policy
  // `ask`). The call is paused on the prompt; answer via respondPermission.
  | {
      kind: "permission_request";
      requestId: string;
      permission: import("@tomat/shared").PermissionKind;
      resource: string;
      apiName?: string;
      declared: boolean;
      reason?: string;
    }
  // The running tool proposed a scheduled prompt (ctx.schedulePrompt). The
  // call is paused until the user confirms (possibly after editing the
  // draft) or rejects in chat; answer via respondSchedule.
  | {
      kind: "schedule_request";
      requestId: string;
      draft: ScheduledPromptDraft;
    }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  | { kind: "stderr_log"; line: string }
  // One-way display push from the tool (ctx.display.*). Chat persists it as
  // a DisplayMessage; no response flows back to the worker.
  | { kind: "display"; content: DisplayContent }
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
  // Allow or reject a pending runtime permission prompt.
  respondPermission(requestId: string, allow: boolean): void;
  // Settle a pending schedule confirm; `draft` carries the user's edits
  // when accepted.
  respondSchedule(requestId: string, accepted: boolean, draft?: ScheduledPromptDraft): void;
  // True while `requestId` is an unanswered schedule confirm for this call.
  // Callers with side effects keyed to the confirm (chat persists the draft)
  // must check this first: a stale or replayed response is otherwise
  // indistinguishable from the real one.
  hasPendingSchedule(requestId: string): boolean;
  // Settle when the worker emits tool_result / tool_error.
  done: Promise<unknown>;
}

export class WorkerPool {
  private config: PoolConfig = DEFAULT_POOL_CONFIG;
  private workers = new Map<string, WorkerHandle>();
  private lru: string[] = []; // toolkitIds in MRU order
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  setConfig(cfg: Partial<PoolConfig>): void {
    this.config = { ...this.config, ...cfg };
  }

  // Execute a single tool call. Returns a controller for cancel/askUser
  // forwarding; the `done` promise settles with the tool's return value
  // (resolved on tool_result) or rejects on tool_error / cancel / timeout.
  startCall(spec: ToolCallStart, onEvent: (event: CallEvent) => void): CallController {
    const callId = newCallId();
    // Workers are keyed per (toolkit, tool), not per toolkit, so each tool runs
    // with ONLY its own granted permissions (least privilege) instead of the
    // union of every enabled tool's grants. `key` is this call's worker
    // identity for the pool/LRU/idle-timer maps.
    const key = workerKey(spec.toolkitId, spec.tool.name);
    const worker = this.getOrSpawn(spec, key);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let settled = false;
    let callStarted = false;
    // Count of prompts (askUser, permission, schedule confirm) currently
    // waiting on the user. The timeout budget pauses while any wait is open
    // and resumes only when the last one settles; a flag per prompt kind
    // would re-arm the timer while a sibling prompt is still pending.
    let pendingUserWaits = 0;
    // Tracks how much of the callTimeoutMs budget is still available so
    // askUser can pause + resume the timer (instead of resetting it).
    let timeoutBudgetMs = this.config.callTimeoutMs;
    let timeoutArmedAt: number | undefined;
    const beginUserWait = () => {
      pendingUserWaits++;
      pauseTimeout();
    };
    const endUserWait = () => {
      pendingUserWaits = Math.max(0, pendingUserWaits - 1);
      if (pendingUserWaits === 0 && timeout === undefined && !cancelled) armTimeout();
    };

    // Outer closures so cancel/respondAskUser can drive them.
    let rejectDone: (err: Error) => void = () => {};
    let offHandler: () => void = () => {};

    // Pending module-broker permission prompts for this call, keyed by
    // requestId. respondPermission answers either one of these or a PTY
    // prompt (worker.answerPrompt); cancel resolves them all as rejected.
    const brokerPrompts = new Map<string, (allow: boolean) => void>();
    // Open requestIds per prompt kind. A respond* with an unknown requestId
    // (stale, replayed, or forged) is dropped whole: forwarding it would
    // resume the timeout budget while the real prompt is still open.
    const pendingAskRequests = new Set<string>();
    const pendingScheduleRequests = new Set<string>();
    const pendingPermRequests = new Set<string>();
    const promptUser = (prompt: ModulePrompt): Promise<boolean> => {
      // Same budget pause as a PTY prompt: waiting on the user's decision
      // must not consume the tool's time budget.
      beginUserWait();
      const requestId = `mod-${crypto.randomUUID()}`;
      return new Promise<boolean>((resolve) => {
        brokerPrompts.set(requestId, resolve);
        onEvent({
          kind: "permission_request",
          requestId,
          permission: prompt.permission,
          resource: prompt.resource,
          declared: prompt.declared,
          reason: prompt.reason,
        });
      });
    };

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
          case "ask_user_request": {
            // The frame passed the structural screen, but the question shapes
            // are toolkit-supplied: a question the client's Zod would reject
            // must not pause the call on a form that never renders. Answer
            // empty instead so the tool's await unwinds.
            const questionsValid =
              Array.isArray(frame.questions) &&
              frame.questions.length > 0 &&
              frame.questions.every((q) => askUserQuestionSchema.safeParse(q).success);
            if (!questionsValid) {
              log.warn(
                `invalid ask_user_request from ${spec.toolkitId}/${spec.tool.name}; answering empty`,
              );
              onEvent({
                kind: "log",
                level: "warn",
                message: "askUser request had invalid questions; answered empty",
              });
              worker.send({
                kind: "ask_user_response",
                callId,
                requestId: frame.requestId,
                answers: [],
              });
              return;
            }
            // Pause the budget: subtract the time we've already consumed,
            // then disarm so the timer can be re-armed on response.
            beginUserWait();
            pendingAskRequests.add(frame.requestId);
            onEvent({
              kind: "ask_user_request",
              requestId: frame.requestId,
              questions: frame.questions,
            });
            return;
          }
          case "schedule_request": {
            // Same reasoning as askUser: a draft the client (or the insert
            // path) would reject must unblock the tool, not strand the call.
            const parsedDraft = scheduledPromptDraftSchema.safeParse(frame.draft);
            if (!parsedDraft.success) {
              log.warn(
                `invalid schedule_request draft from ${spec.toolkitId}/${spec.tool.name}; rejecting`,
              );
              onEvent({
                kind: "log",
                level: "warn",
                message: "schedule proposal had an invalid draft; rejected",
              });
              worker.send({
                kind: "schedule_confirm_response",
                callId,
                requestId: frame.requestId,
                accepted: false,
              });
              return;
            }
            // Same budget pause as askUser: the confirm form waits on the user.
            beginUserWait();
            pendingScheduleRequests.add(frame.requestId);
            onEvent({
              kind: "schedule_request",
              requestId: frame.requestId,
              draft: parsedDraft.data,
            });
            return;
          }
          case "permission_prompt":
            // Same budget pause as askUser: waiting on the user's decision
            // must not consume the tool's time budget. (Auto-denied prompts
            // never reach here; they settle inside the WorkerHandle within
            // about a second, against the running budget.)
            beginUserWait();
            pendingPermRequests.add(frame.requestId);
            onEvent({
              kind: "permission_request",
              requestId: frame.requestId,
              permission: frame.permission,
              resource: frame.resource,
              apiName: frame.apiName,
              declared: frame.declared,
              reason: frame.reason,
            });
            return;
          case "log":
            onEvent({
              kind: "log",
              level: frame.level,
              message: frame.message,
            });
            return;
          case "display": {
            const bounded = boundDisplayContent(frame.content);
            if ("error" in bounded) {
              log.warn(
                `dropping display from ${spec.toolkitId}/${spec.tool.name}: ${bounded.error}`,
              );
              onEvent({ kind: "log", level: "warn", message: `display dropped: ${bounded.error}` });
              return;
            }
            onEvent({ kind: "display", content: bounded.content });
            return;
          }
          case "module_request": {
            const requestId = frame.requestId;
            const respondError = (error: string) =>
              worker.send({ kind: "module_response", callId, requestId, ok: false, error });
            void handleModuleRequest({
              toolkitId: spec.toolkitId,
              toolName: spec.tool.name,
              callId,
              module: frame.module,
              op: frame.op,
              args: frame.args,
              promptUser,
            })
              .then(
                (result) => {
                  try {
                    worker.send({ kind: "module_response", callId, requestId, ok: true, result });
                  } catch (err) {
                    // The result slipped a non-JSON value (send serializes
                    // before writing); fail the module call instead of
                    // letting the worker's await hang.
                    log.warn(
                      `module_response for ${spec.toolkitId}/${spec.tool.name} not serializable: ${errMessage(
                        err,
                      )}`,
                    );
                    respondError("module result was not JSON-serializable");
                  }
                },
                // Module errors flow back into toolkit code; scrub them like
                // log lines so a provider error can't leak a credential.
                (err) => respondError(scrubSecrets(errMessage(err))),
              )
              .catch((err) => {
                log.warn(`module_response delivery failed: ${errMessage(err)}`);
              });
            return;
          }
          case "stderr_log":
            onEvent({ kind: "stderr_log", line: frame.line });
            return;
          case "worker_exited":
            // The process died with a started call still open (crash, OOM, the
            // answer give-up kill, or a refreshPermissions teardown). Settle it
            // now instead of waiting for the call timeout. Pre-boot exits are
            // handled by the waitForBoot rejection below, so ignore those.
            if (settled || !callStarted) return;
            off();
            disarm();
            settled = true;
            // Settle broker prompts still waiting on the user: their module
            // request can never complete on a dead worker, and an unanswered
            // promptUser promise would leak.
            for (const resolve of brokerPrompts.values()) resolve(false);
            brokerPrompts.clear();
            worker.inFlightCalls = Math.max(0, worker.inFlightCalls - 1);
            this.killWorker(key, worker);
            reject(
              new AppError(
                "internal_error",
                cancelled ? "tool call cancelled" : "tool worker exited",
              ),
            );
            return;
          case "tool_result":
            off();
            disarm();
            settled = true;
            worker.inFlightCalls--;
            this.retireOrIdle(key, worker);
            resolve(frame.result);
            return;
          case "tool_error":
            off();
            disarm();
            settled = true;
            worker.inFlightCalls--;
            this.retireOrIdle(key, worker);
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

      worker
        .waitForBoot()
        .then(() => {
          if (cancelled) {
            off();
            reject(new AppError("internal_error", "cancelled before boot"));
            return;
          }
          worker.inFlightCalls++;
          callStarted = true;
          this.clearIdleTimer(key);
          worker.send({
            kind: "call",
            callId,
            toolName: spec.tool.name,
            fnExport: spec.tool.fnExport,
            arguments: spec.argumentsJson,
            chatContext: spec.chatContext,
          });
          armTimeout();
        })
        .catch((err) => {
          // Worker boot failed → synthesize a tool_error event so the UI
          // doesn't hang in "running", then reject `done` so the caller's
          // catch path runs. Without the synthetic event the chat-side
          // ToolCall bubble would never reach a terminal state.
          off();
          settled = true;
          worker.inFlightCalls = Math.max(0, worker.inFlightCalls - 1);
          this.bumpIdleTimer(key);
          const msg = errMessage(err);
          try {
            onEvent({
              kind: "log",
              level: "error",
              message: `worker boot failed: ${msg}`,
            });
          } catch {
            /* listener errors are non-fatal here */
          }
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
        if (pendingUserWaits > 0) {
          // Defensive: with the wait refcount the timer should never fire
          // while a prompt is open. Clear the spent handle so endUserWait
          // can re-arm with the remaining budget.
          timeout = undefined;
          timeoutArmedAt = undefined;
          return;
        }
        // Bookkeeping must run even if the worker is already dead. Otherwise the
        // listener leaks and `done` hangs.
        offHandler();
        settled = true;
        worker.inFlightCalls = Math.max(0, worker.inFlightCalls - 1);
        // A cooperative `cancel` frame is useless against a CPU-bound or wedged
        // tool: it never reaches the worker's event loop. Force-kill the worker
        // and drop it from the pool so it stops burning a core, instead of
        // leaving it warm until idle eviction (~5 min). A fresh worker spawns on
        // the next call.
        this.killWorker(key, worker);
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
        } catch {
          /* listener errors are non-fatal here */
        }
        // Settle any broker prompt still waiting on the user as rejected so
        // the module request resolves and the worker's await can unwind.
        for (const resolve of brokerPrompts.values()) resolve(false);
        brokerPrompts.clear();
        worker.send({ kind: "cancel", callId });
        disarm();
        // If the worker doesn't ack the cancel within a short grace window
        // (wedged / CPU-bound, so the cooperative frame never runs), force-kill
        // it so `done` settles and the process stops consuming a core.
        setTimeout(() => {
          if (settled) return;
          settled = true;
          offHandler();
          worker.inFlightCalls = Math.max(0, worker.inFlightCalls - 1);
          this.killWorker(key, worker);
          rejectDone(new AppError("internal_error", "tool call cancelled"));
        }, this.config.drainTimeoutMs);
      },
      respondAskUser: (requestId, answers) => {
        if (!pendingAskRequests.delete(requestId)) return;
        worker.send({
          kind: "ask_user_response",
          callId,
          requestId,
          answers,
        });
        // Resume the timer with the REMAINING budget instead of a fresh
        // callTimeoutMs window (once no sibling prompt is still open). Slow
        // user answers shouldn't extend the tool's effective time budget.
        endUserWait();
      },
      respondPermission: (requestId, allow) => {
        const brokerResolve = brokerPrompts.get(requestId);
        if (brokerResolve) {
          brokerPrompts.delete(requestId);
          brokerResolve(allow);
        } else if (pendingPermRequests.delete(requestId)) {
          worker.answerPrompt(requestId, allow);
        } else {
          return;
        }
        // Same remaining-budget resume as askUser. The re-armed timer also
        // backstops the rare case where Deno never confirms the answer: the
        // handle kills the worker after its give-up window and the call
        // settles here via timeout.
        endUserWait();
      },
      respondSchedule: (requestId, accepted, draft) => {
        if (!pendingScheduleRequests.delete(requestId)) return;
        worker.send({
          kind: "schedule_confirm_response",
          callId,
          requestId,
          accepted,
          draft,
        });
        // Same remaining-budget resume as askUser.
        endUserWait();
      },
      hasPendingSchedule: (requestId) => pendingScheduleRequests.has(requestId),
      done,
    };
  }

  // Kill every warm worker for `toolkitId` (e.g. after a grant change). Workers
  // are keyed per (toolkit, tool), so a single toolkit can have several; tear
  // them all down. Any in-flight calls receive tool_error via the worker's
  // exit -> rejection path.
  async refreshPermissions(toolkitId: string): Promise<void> {
    const prefix = workerKey(toolkitId, "");
    const keys = [...this.workers.keys()].filter((k) => k.startsWith(prefix));
    if (keys.length === 0) return;
    log.info(`refreshPermissions: terminating ${keys.length} warm worker(s) for ${toolkitId}`);
    for (const key of keys) {
      const w = this.workers.get(key);
      if (!w) continue;
      await w.terminate(this.config.drainTimeoutMs);
      this.workers.delete(key);
      this.removeFromLru(key);
      this.clearIdleTimer(key);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.workers.values(), (w) => w.terminate(this.config.drainTimeoutMs)),
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

  private getOrSpawn(spec: ToolCallStart, key: string): WorkerHandle {
    const existing = this.workers.get(key);
    if (existing) {
      this.touchLru(key);
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
    return this.spawn(spec, key);
  }

  private spawn(spec: ToolCallStart, key: string): WorkerHandle {
    const toolkit = toolkitsRegistry().getOrThrow(spec.toolkitId);
    // Least privilege: the worker's --allow-* flags come from ONLY the tool
    // being invoked, not the union of every enabled tool in the toolkit. So a
    // benign tool can't run in a process that holds a sibling tool's net / run
    // / ffi grants. The invoked tool's persisted required-permissions + grants
    // are looked up from the registry by name.
    const tool = toolkitsRegistry()
      .listTools(spec.toolkitId)
      .find((t) => t.name === spec.tool.name);
    const grantContexts = tool ? [{ required: tool.requiredPermissions, grants: tool.grants }] : [];
    void spec.required; // retained on ToolCallStart for back-compat; not used here
    const templates: PathTemplates = {
      home: Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "",
      downloads: defaultDownloadsDir(),
      models: paths().modelsDir,
      sessions: paths().sessionsDir,
      toolkit: toolkit.installedPath,
    };
    const flagSet =
      grantContexts.length > 0 ? unionFlags(grantContexts, templates) : emptyFlagSet();

    // Surface elevated grants in the log so an operator notices an over-broad
    // permission (these escape the Deno sandbox or expose much of $home; the
    // secret vault itself is always denied, see worker-handle.ts). Informational
    // only; the grant was already approved by the user.
    const elevated: string[] = [];
    if (flagSet.ffi) elevated.push("ffi");
    if (flagSet.run.size > 0) {
      elevated.push(`run(${[...flagSet.run].join(",")})`);
    }
    if (templates.home) {
      for (const p of [...flagSet.read, ...flagSet.write]) {
        if (p === templates.home || p === templates.home + "/") {
          elevated.push(`home-wide(${p})`);
        }
      }
    }
    if (elevated.length > 0) {
      log.warn(
        `tool ${spec.toolkitId}/${spec.tool.name} granted elevated permissions: ${elevated.join(
          ", ",
        )}`,
      );
    }

    const flags = flagSetToArgs(flagSet);

    const w = WorkerHandle.spawn({
      toolkitId: spec.toolkitId,
      entryPath: resolveEntryPath(toolkit.installedPath),
      toolkitFolder: toolkit.installedPath,
      flags,
      // Runtime prompt policy: ask-state (or undeclared, per toolkit policy)
      // accesses pause on Deno's prompt and route through prompt-matcher.ts.
      promptContext: tool
        ? {
            required: tool.requiredPermissions,
            grants: tool.grants,
            undeclaredPolicy: toolkit.undeclaredPolicy,
            templates,
          }
        : undefined,
    });
    this.workers.set(key, w);
    this.touchLru(key);
    return w;
  }

  // Normal call-settle path: return the worker to the warm set, UNLESS a
  // user-answered permission prompt happened during its lifetime. Deno caches
  // the per-resource verdict for the process lifetime and prompt answers are
  // scoped to a single call, so such a worker must not serve another call.
  private retireOrIdle(key: string, worker: WorkerHandle): void {
    if (worker.promptAnsweredByUser) {
      log.info(`retiring worker after user-answered permission prompt (${key.split("\u0000")[0]})`);
      this.killWorker(key, worker);
      return;
    }
    this.bumpIdleTimer(key);
  }

  // Force-kill a specific worker and drop it from the pool. Used when a call
  // times out or a cancel goes unacked: the worker is wedged/CPU-bound, so we
  // can't reuse it. The identity check avoids tearing down a replacement worker
  // that may already have taken this key.
  private killWorker(key: string, worker: WorkerHandle): void {
    if (this.workers.get(key) === worker) {
      this.workers.delete(key);
      this.removeFromLru(key);
      this.clearIdleTimer(key);
    }
    void worker.terminate(this.config.drainTimeoutMs);
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
    this.idleTimers.set(toolkitId, t);
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

/** Pool/LRU/idle-timer identity for a worker: one process per (toolkit, tool)
 *  so each tool runs with only its own permissions. The NUL separator can't
 *  appear in a toolkit id or tool name, so `startsWith(workerKey(id, ""))`
 *  safely matches every tool-worker of a toolkit (used by refreshPermissions). */
function workerKey(toolkitId: string, toolName: string): string {
  return `${toolkitId}\u0000${toolName}`;
}

function resolveEntryPath(toolkitFolder: string): string {
  // Resolution order: deno.json "exports" (string form) for deno-native
  // toolkits (e.g. the built-in, which ships no package.json), then
  // package.json "main" for npm-extracted toolkits, then the index.ts
  // convention. The worker imports this via file://, so we just need the right
  // entry file.
  try {
    const cfg = JSON.parse(Deno.readTextFileSync(`${toolkitFolder}/deno.json`)) as {
      exports?: unknown;
    };
    if (typeof cfg.exports === "string" && cfg.exports.length > 0) {
      return `${toolkitFolder}/${cfg.exports.replace(/^\.\//, "")}`;
    }
  } catch {
    /* no deno.json (or no string exports) */
  }
  try {
    const pkg = JSON.parse(Deno.readTextFileSync(`${toolkitFolder}/package.json`)) as {
      main?: string;
    };
    if (typeof pkg.main === "string" && pkg.main.length > 0) {
      return `${toolkitFolder}/${pkg.main.replace(/^\.\//, "")}`;
    }
  } catch {
    /* no package.json */
  }
  return `${toolkitFolder}/index.ts`;
}

// Bounds for tool display payloads: accepted content is persisted into the
// session file (rewritten on every later message) and broadcast to every
// client, so oversize markdown is truncated and the kinds that cannot be
// truncated without changing their meaning are dropped.
const DISPLAY_TEXT_MAX_CHARS = 256_000;
const DISPLAY_IMAGE_MAX_B64_CHARS = 8_000_000;
const DISPLAY_TABLE_MAX_ROWS = 1_000;
const DISPLAY_TABLE_MAX_COLUMNS = 64;
const DISPLAY_TABLE_MAX_CELL_CHARS = 4_096;

function boundDisplayContent(
  content: DisplayContent,
): { content: DisplayContent } | { error: string } {
  switch (content.type) {
    case "markdown":
      if (content.markdown.length > DISPLAY_TEXT_MAX_CHARS) {
        return {
          content: {
            type: "markdown",
            markdown: content.markdown.slice(0, DISPLAY_TEXT_MAX_CHARS) + "\n\n[truncated]",
          },
        };
      }
      return { content };
    case "image":
      if (content.dataB64.length > DISPLAY_IMAGE_MAX_B64_CHARS) {
        return { error: `image exceeds ${DISPLAY_IMAGE_MAX_B64_CHARS} base64 characters` };
      }
      return { content };
    case "table": {
      if (content.columns.length > DISPLAY_TABLE_MAX_COLUMNS) {
        return { error: `table exceeds ${DISPLAY_TABLE_MAX_COLUMNS} columns` };
      }
      if (content.rows.length > DISPLAY_TABLE_MAX_ROWS) {
        return { error: `table exceeds ${DISPLAY_TABLE_MAX_ROWS} rows` };
      }
      const oversizeCell =
        content.columns.some((c) => c.length > DISPLAY_TABLE_MAX_CELL_CHARS) ||
        content.rows.some((r) => r.some((c) => c.length > DISPLAY_TABLE_MAX_CELL_CHARS));
      if (oversizeCell) {
        return { error: `table cell exceeds ${DISPLAY_TABLE_MAX_CELL_CHARS} characters` };
      }
      return { content };
    }
    case "diff":
      if (
        content.before.length > DISPLAY_TEXT_MAX_CHARS ||
        content.after.length > DISPLAY_TEXT_MAX_CHARS
      ) {
        return { error: `diff side exceeds ${DISPLAY_TEXT_MAX_CHARS} characters` };
      }
      return { content };
  }
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
