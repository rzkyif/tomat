// One running tool-worker subprocess + NDJSON channel.
//
// Two spawn modes:
//
//  - PTY mode (default when the tomat-core-ptyhost helper is present and the
//    platform is unix): the worker runs under the helper with stdin + stderr
//    on a pseudo-terminal, WITHOUT --no-prompt, so Deno pauses on permission
//    prompts for anything outside the granted spawn flags. The handle parses
//    prompt text off the PTY (prompt-parser.ts), consults the grant policy
//    (prompt-matcher.ts), and either auto-answers or surfaces a synthesized
//    `permission_prompt` frame for the pool to forward to the user. Worker
//    stdout is inherited through the helper, so the protocol stream is
//    identical in both modes.
//
//  - Pipe mode (helper missing, Windows, or no prompt context): today's
//    direct spawn with --no-prompt; ask-state permissions surface to the
//    tool as NotCapable.

import { join } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { errMessage } from "@tomat/shared";
import { binPath } from "../paths.ts";
import { paths } from "../paths.ts";
import { binaryName, coreBinaryName } from "../binaries/versions.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import {
  parseWorkerFrame,
  type PoolToWorkerFrame,
  type WorkerToPoolFrame,
} from "./worker-protocol.ts";
import { PromptParser, type PromptParserEvent } from "./prompt-parser.ts";
import { decidePrompt, type PromptContext } from "./prompt-matcher.ts";

const log = getLogger("toolworker");

// Bound the per-stream line buffers so a malicious or buggy tool can't exhaust
// core's memory by emitting an endless stream with no newline. Protocol frames
// (NDJSON on stdout) are normally tiny; 16 MB is generous headroom for a large
// tool result. stderr is just log lines, so a 1 MB cap is plenty.
const MAX_STDOUT_FRAME_BYTES = 16_000_000;
const MAX_STDERR_LINE_BYTES = 1_000_000;

// Prompt answer timing. Deno's prompter flushes stdin until it has been
// quiescent for ~100 ms before reading the answer (clear_stdin in
// prompter.rs), so an immediate write gets eaten: write no sooner than
// 300 ms after the prompt appeared and retry until the Granted/Denied
// confirmation shows. If it never does (format drift, wedged terminal),
// give up and kill the worker; the call then settles via the pool timeout.
const ANSWER_INITIAL_DELAY_MS = 300;
const ANSWER_RETRY_MS = 600;
const ANSWER_GIVEUP_MS = 10_000;

// Non-secret operational env a tool worker may legitimately need (PATH so a
// `run`-granted tool can resolve binaries, HOME/temp/locale). Everything else
// the core process holds (e.g. an operator's OPENAI_API_KEY, TOMAT_* vars) is
// dropped via clearEnv; env keys the tool was explicitly granted are re-added.
const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // Windows essentials.
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ComSpec",
  "PATHEXT",
];

export interface SpawnSpec {
  toolkitId: string;
  entryPath: string; // absolute path to the toolkit's entry .ts/.js
  toolkitFolder: string; // absolute path; passed to --allow-read + --config
  flags: string[]; // computed --allow-* set (no --allow-read for the folder; we add it)
  // Declared permissions + grants + undeclared policy for runtime prompt
  // decisions. Absent (e.g. pool tests) forces pipe mode.
  promptContext?: PromptContext;
}

export type WorkerListener = (frame: WorkerToPoolFrame) => void;

// Control frames understood by the tomat-core-ptyhost helper (see its
// src/main.rs header).
type PtyhostControlFrame =
  | {
      kind: "spawn";
      cmd: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | { kind: "write"; dataB64: string }
  | { kind: "kill" };

type PtyhostEvent =
  | { kind: "pty"; dataB64: string }
  | { kind: "exit"; code: number }
  | { kind: "fatal"; error: string };

export function ptyhostPath(): string {
  return binPath(coreBinaryName("tomat-core-ptyhost"));
}

function ptyhostAvailableSync(): boolean {
  if (Deno.build.os === "windows") return false;
  try {
    return Deno.statSync(ptyhostPath()).isFile;
  } catch {
    return false;
  }
}

export class WorkerHandle {
  private proc: Deno.ChildProcess;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private listeners = new Set<WorkerListener>();
  private decoder = new TextDecoder();
  private buf = "";
  private booted = false;
  private bootWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  readonly toolkitId: string;
  readonly spawnedAt = Date.now();
  inFlightCalls = 0;
  lastActivityAt = Date.now();

  // --- PTY mode state ------------------------------------------------------
  private readonly ptyMode: boolean;
  private readonly promptContext: PromptContext | undefined;
  private promptParser: PromptParser | undefined;
  // Serialized frames queued while a prompt is pending: Deno's clear_stdin
  // would flush them off the PTY before reading the answer.
  private sendQueue: string[] = [];
  private promptPending = false;
  private promptSeenAt = 0;
  private promptRequestId: string | null = null;
  private promptForwarded = false;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  /** True once a user-forwarded prompt settled (either way) during this
   *  worker's lifetime. Deno caches the verdict per resource for the process
   *  lifetime and accepts are scoped to one call, so the pool must retire
   *  the worker instead of returning it to the warm set. */
  promptAnsweredByUser = false;

  static spawn(spec: SpawnSpec): WorkerHandle {
    const denoBin = binPath(binaryName("deno"));
    // Runtime-resolved path (not new URL(..., import.meta.url)) keeps the
    // worker .ts out of deno-compile's static import graph; see the workersDir
    // comment in paths.ts.
    const entry = join(paths().workersDir, "tool-worker.ts");
    // The shipped deno.json is the toolkit's runtime config (imports incl. npm:
    // deps). Pass it via --config when present; npm-only toolkits (no deno.json)
    // rely on deno's package.json auto-discovery instead. We never write it.
    const configPath = join(spec.toolkitFolder, "deno.json");
    const hasDenoJson = fileExistsSync(configPath);
    // A deno.lock exists only after `deno install` ran (deps present). When it
    // does, run --frozen so the worker never tries to rewrite it at runtime (it
    // holds no write grant for the folder).
    const hasLock = fileExistsSync(join(spec.toolkitFolder, "deno.lock"));
    // Defense in depth: never let a tool worker read or write the core's secret
    // material, even if it was granted a broad path like `$home` (which
    // contains ~/.tomat). Deno's --deny-* flags take precedence over any
    // --allow-*, so this holds regardless of the granted permission set. A
    // blanket deny of `root` isn't usable because sessions live under it (and a
    // tool may be granted $sessions), so the sensitive subtrees and files are
    // enumerated explicitly, including the transient/legacy siblings.
    const p = paths();
    const deniedPaths = [
      p.secretsEncFile,
      p.secretsEncFile + ".tmp", // transient write target during re-encrypt
      p.secretsPlainFile, // legacy plaintext path (declared but unused)
      join(p.root, ".master-key"),
      p.adminTokenFile,
      p.dbFile,
      p.dbFile + "-wal",
      p.dbFile + "-shm",
      p.dbFile + "-journal", // non-WAL fallback journal
      // Every toolkit's private SQLite db and the documents store are reached
      // ONLY through the core-side module broker (proxied over stdio), so a
      // worker never needs fs access to them. Deny the whole subtrees so a tool
      // granted a broad ancestor path (e.g. $home, which contains ~/.tomat)
      // still can't read another toolkit's data or the documents store off disk.
      join(p.root, "toolkit-data"),
      p.documentsDir,
    ].join(",");
    const ptyMode = spec.promptContext !== undefined && ptyhostAvailableSync();
    const args = [
      "run",
      // In PTY mode prompts are the whole point; in pipe mode they would
      // block forever on a non-terminal, so they stay disabled.
      ...(ptyMode ? [] : ["--no-prompt"]),
      "--no-check",
      "--quiet",
      // node_modules was created in the folder by `deno install --node-modules-dir=auto`;
      // resolve npm deps from it (the folder is allow-read'd below).
      "--node-modules-dir=auto",
      ...(hasLock ? ["--frozen"] : []),
      ...spec.flags,
      `--allow-read=${spec.toolkitFolder},${paths().denoCacheDir}`,
      `--deny-read=${deniedPaths}`,
      `--deny-write=${deniedPaths}`,
      ...(hasDenoJson ? ["--config", configPath] : []),
      entry,
      `--toolkit-id=${spec.toolkitId}`,
      `--entry=${spec.entryPath}`,
    ];
    // Build the worker env explicitly. clearEnv drops the inherited superset so
    // the --allow-env list is authoritative: only DENO_DIR, a non-secret
    // operational base, and the keys the tool was actually granted are present.
    const env: Record<string, string> = { DENO_DIR: paths().denoCacheDir };
    for (const key of WORKER_ENV_ALLOWLIST) {
      const v = Deno.env.get(key);
      if (v !== undefined) env[key] = v;
    }
    const allowEnvFlag = spec.flags.find((f) => f.startsWith("--allow-env="));
    if (allowEnvFlag) {
      for (const key of allowEnvFlag.slice("--allow-env=".length).split(",")) {
        if (!key) continue;
        const v = Deno.env.get(key);
        if (v !== undefined) env[key] = v;
      }
    }
    if (ptyMode) {
      // The helper gets an empty env on purpose: the child's env is carried
      // entirely by the spawn control frame (helper applies env_clear).
      const proc = new Deno.Command(ptyhostPath(), {
        args: [],
        clearEnv: true,
        env: {},
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const handle = new WorkerHandle(proc, spec.toolkitId, true, spec.promptContext);
      handle.writeControl({ kind: "spawn", cmd: denoBin, args, env });
      return handle;
    }
    if (spec.promptContext !== undefined) {
      log.warn(
        `[${spec.toolkitId}] tomat-core-ptyhost unavailable; runtime permission prompts disabled (ask-state permissions fail as NotCapable)`,
      );
    }
    const proc = new Deno.Command(denoBin, {
      args,
      clearEnv: true,
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    return new WorkerHandle(proc, spec.toolkitId, false, undefined);
  }

  private constructor(
    proc: Deno.ChildProcess,
    toolkitId: string,
    ptyMode: boolean,
    promptContext: PromptContext | undefined,
  ) {
    this.proc = proc;
    this.writer = proc.stdin.getWriter();
    this.toolkitId = toolkitId;
    this.ptyMode = ptyMode;
    this.promptContext = promptContext;
    void this.pumpStdout(proc.stdout);
    if (ptyMode) {
      this.promptParser = new PromptParser((e) => this.onPromptEvent(e));
      void this.pumpPtyhostEvents(proc.stderr);
    } else {
      void this.pumpStderr(proc.stderr);
    }
    void proc.status.then((s) => {
      log.warn(`[${this.toolkitId}] worker exited (code=${s.code})`);
      this.failBoot(new AppError("internal_error", "worker exited"));
      // Settle any started call still waiting on this worker. Pre-boot calls
      // are handled by the failBoot rejection above; started calls listen for
      // this frame (no callId, so it reaches every in-flight call's listener).
      this.emit({ kind: "worker_exited", code: s.code });
    });
  }

  on(listener: WorkerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitForBoot(timeoutMs = 10_000): Promise<void> {
    if (this.booted) return;
    return await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("worker boot timeout")), timeoutMs);
      this.bootWaiters.push({
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
        reject: (err) => {
          clearTimeout(t);
          reject(err);
        },
      });
    });
  }

  send(frame: PoolToWorkerFrame): void {
    this.lastActivityAt = Date.now();
    // Serialize before any queueing or write decision: an unserializable
    // frame (e.g. a module result carrying a non-JSON value) must throw to
    // the caller, not die inside a swallowed write or an unawaited PTY path.
    const line = JSON.stringify(frame) + "\n";
    if (this.ptyMode) {
      // While a prompt is pending, Deno's clear_stdin would flush anything
      // written to the PTY before reading the answer; hold frames until the
      // prompt settles. (A cancel racing a prompt is covered by the pool's
      // force-kill fallback.)
      if (this.promptPending) {
        this.sendQueue.push(line);
        return;
      }
      this.writeLine(line);
      return;
    }
    try {
      this.writer.write(new TextEncoder().encode(line)).catch(() => {});
    } catch {
      // writer closed; ignore (worker is dying)
    }
  }

  /** Answer a forwarded permission prompt. No-op unless `requestId` is the
   *  currently pending prompt (stale responses after a settle are dropped). */
  answerPrompt(requestId: string, allow: boolean): void {
    if (!this.promptPending || this.promptRequestId !== requestId) return;
    this.startAnswer(allow);
  }

  async terminate(drainTimeoutMs = 2_000): Promise<void> {
    // Stop any in-progress answer-retry loop so it can't keep firing (and
    // re-issuing a kill) for up to ANSWER_GIVEUP_MS after the worker is gone.
    this.promptPending = false;
    this.stopAnswerTimer();
    try {
      if (this.ptyMode) {
        this.writeWorkerFrame({ kind: "shutdown" });
      } else {
        this.send({ kind: "shutdown" });
      }
    } catch {
      /* ignore */
    }
    const dead = await Promise.race([
      this.proc.status.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), drainTimeoutMs)),
    ]);
    if (!dead) {
      try {
        if (this.ptyMode) {
          // Ask the helper to SIGKILL the worker; it then exits itself.
          this.writeControl({ kind: "kill" });
          const killed = await Promise.race([
            this.proc.status.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
          ]);
          if (killed) return;
        }
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    try {
      await this.proc.status;
    } catch {
      /* ignore */
    }
  }

  // --- PTY plumbing --------------------------------------------------------

  private writeControl(frame: PtyhostControlFrame): void {
    try {
      this.writer.write(new TextEncoder().encode(JSON.stringify(frame) + "\n")).catch(() => {});
    } catch {
      // writer closed; ignore (helper is dying)
    }
  }

  private writeWorkerFrame(frame: PoolToWorkerFrame): void {
    this.writeLine(JSON.stringify(frame) + "\n");
  }

  private writeLine(line: string): void {
    this.writeControl({
      kind: "write",
      dataB64: encodeBase64(new TextEncoder().encode(line)),
    });
  }

  private async pumpPtyhostEvents(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: PtyhostEvent;
        try {
          event = JSON.parse(line) as PtyhostEvent;
        } catch {
          log.warn(`[${this.toolkitId}] bad ptyhost event: ${line.slice(0, 200)}`);
          continue;
        }
        if (event.kind === "pty") {
          try {
            this.promptParser?.feed(this.decoder.decode(decodeBase64(event.dataB64)));
          } catch {
            log.warn(`[${this.toolkitId}] undecodable pty event`);
          }
        } else if (event.kind === "fatal") {
          log.warn(`[${this.toolkitId}] ptyhost fatal: ${event.error}`);
        }
        // exit events need no handling: the helper mirrors the worker's exit
        // code, so proc.status covers it.
      }
    }
  }

  private onPromptEvent(event: PromptParserEvent): void {
    if (event.kind === "stderr_line") {
      if (event.line.length > MAX_STDERR_LINE_BYTES) {
        this.emit({
          kind: "stderr_log",
          line: event.line.slice(0, MAX_STDERR_LINE_BYTES) + " …[truncated]",
        });
        return;
      }
      this.emit({ kind: "stderr_log", line: event.line });
      return;
    }
    if (event.kind === "prompt") {
      this.promptPending = true;
      this.promptSeenAt = Date.now();
      this.promptRequestId = `perm-${crypto.randomUUID()}`;
      this.promptForwarded = false;
      const ctx = this.promptContext;
      const decision = ctx ? decidePrompt(event, ctx) : null;
      if (decision === null || decision.action === "deny") {
        const why = decision === null ? "unrecognized permission kind" : "permission policy";
        this.emit({
          kind: "stderr_log",
          line: `auto-denied ${event.permission} access to ${event.resource || "(all)"} (${why})`,
        });
        this.startAnswer(false);
        return;
      }
      // A Deno prompt blocks the worker's whole isolate, so when more than one
      // call shares this worker (warm workers are reused across sessions) we
      // can't attribute the prompt to a single call: the synthesized frame
      // carries no callId and would fan out to every in-flight call's listener.
      // Fail closed rather than forward an ambiguous prompt; the affected call
      // sees NotCapable, exactly as in pipe mode.
      if (this.inFlightCalls > 1) {
        this.emit({
          kind: "stderr_log",
          line: `auto-denied ${event.permission} access to ${
            event.resource || "(all)"
          } (concurrent calls share this worker; cannot attribute the prompt)`,
        });
        this.startAnswer(false);
        return;
      }
      this.promptForwarded = true;
      this.emit({
        kind: "permission_prompt",
        requestId: this.promptRequestId,
        permission: decision.permissionKind,
        resource: event.resource,
        apiName: event.apiName,
        declared: decision.declared,
        reason: decision.reason,
      });
      return;
    }
    // settled
    if (this.promptForwarded) this.promptAnsweredByUser = true;
    this.promptPending = false;
    this.promptRequestId = null;
    this.promptForwarded = false;
    this.stopAnswerTimer();
    const queued = this.sendQueue;
    this.sendQueue = [];
    for (const line of queued) this.writeLine(line);
  }

  private startAnswer(allow: boolean): void {
    this.stopAnswerTimer();
    const startedAt = Date.now();
    const payload = encodeBase64(new TextEncoder().encode(allow ? "y\n" : "n\n"));
    const tick = () => {
      if (!this.promptPending) return;
      if (Date.now() - startedAt > ANSWER_GIVEUP_MS) {
        // The confirmation never came (prompt format drift or a wedged
        // terminal). Fail closed: kill the worker; the in-flight call then
        // settles via the pool's timeout/kill machinery.
        this.emit({
          kind: "stderr_log",
          line: "permission prompt answer was not accepted; killing worker",
        });
        this.writeControl({ kind: "kill" });
        return;
      }
      this.writeControl({ kind: "write", dataB64: payload });
      this.answerTimer = setTimeout(tick, ANSWER_RETRY_MS);
    };
    const initialDelay = Math.max(0, ANSWER_INITIAL_DELAY_MS - (Date.now() - this.promptSeenAt));
    this.answerTimer = setTimeout(tick, initialDelay);
  }

  private stopAnswerTimer(): void {
    if (this.answerTimer !== undefined) {
      clearTimeout(this.answerTimer);
      this.answerTimer = undefined;
    }
  }

  // --- shared plumbing -----------------------------------------------------

  private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const chunk of stream) {
      this.buf += this.decoder.decode(chunk, { stream: true });
      if (this.buf.length > MAX_STDOUT_FRAME_BYTES) {
        // Oversized partial frame with no newline: drop it to bound memory.
        // The in-flight call will fail/timeout via the normal paths.
        log.warn(`[${this.toolkitId}] dropping oversized stdout frame (${this.buf.length} bytes)`);
        this.buf = "";
        continue;
      }
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          // The worker process is sandboxed but untrusted: screen every frame
          // structurally and reject the kinds only this handle may synthesize
          // (permission_prompt, worker_exited, stderr_log), so a toolkit
          // cannot forge a permission prompt or a fake exit by printing JSON.
          const frame = parseWorkerFrame(JSON.parse(line));
          if (!frame) {
            log.warn(`[${this.toolkitId}] dropping invalid frame: ${line.slice(0, 200)}`);
            continue;
          }
          this.handle(frame);
        } catch {
          log.warn(`[${this.toolkitId}] bad frame: ${line.slice(0, 200)}`);
        }
      }
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      if (buf.length > MAX_STDERR_LINE_BYTES) {
        // Truncate a runaway no-newline stderr line to bound memory.
        this.emit({
          kind: "stderr_log",
          line: buf.slice(0, MAX_STDERR_LINE_BYTES) + " …[truncated]",
        });
        buf = "";
        continue;
      }
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.emit({ kind: "stderr_log", line });
      }
    }
  }

  private handle(frame: WorkerToPoolFrame): void {
    this.lastActivityAt = Date.now();
    if (frame.kind === "ready") return; // ack only
    if (frame.kind === "booted") {
      this.booted = true;
      for (const w of this.bootWaiters) w.resolve();
      this.bootWaiters = [];
      return;
    }
    if (frame.kind === "boot_failed") {
      const err = new AppError("internal_error", `boot failed: ${frame.error}`);
      for (const w of this.bootWaiters) w.reject(err);
      this.bootWaiters = [];
      return;
    }
    this.emit(frame);
  }

  private emit(frame: WorkerToPoolFrame): void {
    for (const l of this.listeners) {
      try {
        l(frame);
      } catch (err) {
        log.warn(`worker listener threw: ${errMessage(err)}`);
      }
    }
  }

  private failBoot(err: Error): void {
    for (const w of this.bootWaiters) w.reject(err);
    this.bootWaiters = [];
  }
}

function fileExistsSync(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}
