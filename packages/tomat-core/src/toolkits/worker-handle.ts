// One running tool-worker subprocess + NDJSON channel.

import { join } from "@std/path";
import { errMessage } from "@tomat/shared";
import { binPath } from "../paths.ts";
import { paths } from "../paths.ts";
import { binaryName } from "../binaries/versions.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import type { PoolToWorkerFrame, WorkerToPoolFrame } from "./worker-protocol.ts";

const log = getLogger("toolworker");

// Bound the per-stream line buffers so a malicious or buggy tool can't exhaust
// core's memory by emitting an endless stream with no newline. Protocol frames
// (NDJSON on stdout) are normally tiny; 16 MB is generous headroom for a large
// tool result. stderr is just log lines, so a 1 MB cap is plenty.
const MAX_STDOUT_FRAME_BYTES = 16_000_000;
const MAX_STDERR_LINE_BYTES = 1_000_000;

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
}

export type WorkerListener = (frame: WorkerToPoolFrame) => void;

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

  static spawn(spec: SpawnSpec): WorkerHandle {
    const denoBin = binPath(binaryName("deno"));
    // Runtime-resolved path keeps the worker .ts out of deno-compile's
    // static graph; see sidecars/embedding.ts header.
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
    // tool may be granted $sessions), so the secret + DB files are enumerated
    // exhaustively, including the transient/legacy siblings.
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
    ].join(",");
    const args = [
      "run",
      "--no-prompt",
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
    const proc = new Deno.Command(denoBin, {
      args,
      clearEnv: true,
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    return new WorkerHandle(proc, spec.toolkitId);
  }

  private constructor(proc: Deno.ChildProcess, toolkitId: string) {
    this.proc = proc;
    this.writer = proc.stdin.getWriter();
    this.toolkitId = toolkitId;
    void this.pumpStdout(proc.stdout);
    void this.pumpStderr(proc.stderr);
    void proc.status.then((s) => {
      log.warn(`[${this.toolkitId}] worker exited (code=${s.code})`);
      this.failBoot(new AppError("internal_error", "worker exited"));
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
    try {
      this.writer.write(new TextEncoder().encode(JSON.stringify(frame) + "\n")).catch(() => {});
    } catch {
      // writer closed; ignore (worker is dying)
    }
  }

  async terminate(drainTimeoutMs = 2_000): Promise<void> {
    try {
      this.send({ kind: "shutdown" });
    } catch {
      /* ignore */
    }
    const dead = await Promise.race([
      this.proc.status.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), drainTimeoutMs)),
    ]);
    if (!dead) {
      try {
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
          const frame = JSON.parse(line) as WorkerToPoolFrame;
          this.handle(frame);
        } catch {
          log.warn(`[${this.toolkitId}] bad frame: ${line}`);
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
