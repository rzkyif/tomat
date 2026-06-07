// Host-side embedding controller. Spawns workers/embedding-worker.ts as a
// Deno subprocess with minimal permissions, sends NDJSON embed frames over
// stdin, and parses base64-encoded Float32Array responses from stdout into
// Promises.
//
// Spawn flags:
//   deno run --allow-read=<models-dir> --allow-env=ORT_LOG_LEVEL
//            <core>/workers/embedding-worker.ts <models-dir>
//
// The transformers/onnxruntime dependency (~340 MB) lives only inside this
// subprocess, keeping the main tomat-core binary lean. The subprocess is
// kept warm for the host's lifetime; respawn happens automatically if it
// crashes.

import { join } from "@std/path";
import { errMessage } from "@tomat/shared";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { trackSidecarPid } from "./jobctl.ts";
import { requireWorkerDeno } from "./worker-deno.ts";

const log = getLogger("embedding");

// Boot handshake deadline: the worker must emit `ready` within this.
const BOOT_TIMEOUT_MS = 5_000;
// Per-embed deadline. chat tool-filtering awaits embed() inline, so a
// wedged-but-alive worker (lost frame, ORT stall) must not hang the turn
// forever.
const EMBED_CALL_TIMEOUT_MS = 30_000;
// Crash backoff: after a failed boot, refuse new spawns for a growing window so
// a deterministically-crashing worker (corrupt model, missing dep) is not
// re-spawned (a ~340MB import) on every embed() call.
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type WorkerFrame =
  | { kind: "ready" }
  | { kind: "embedded"; id: string; vectorsBase64: string[] }
  | { kind: "embed_err"; id: string; error: string };

interface PendingEmbed {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EmbeddingController {
  private proc: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private ready = false;
  private spawning: Promise<void> | null = null;
  private pending = new Map<string, PendingEmbed>();
  private counter = 0;
  // Boot handshake settlers, owned by the in-flight spawn(); the `ready` frame
  // resolves and a subprocess exit rejects, instead of a self-rescheduling poll.
  private bootResolve: (() => void) | null = null;
  private bootReject: ((err: Error) => void) | null = null;
  // Crash-backoff state.
  private consecutiveBootFailures = 0;
  private nextRetryAt = 0;

  private workerEntry(): string {
    // Resolved at runtime to escape `deno compile`'s static analyzer.
    // Source location is paths().workersDir (= ~/.tomat/core/workers in
    // prod, overridden to the in-repo source path during dev).
    return join(paths().workersDir, "embedding-worker.ts");
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensureSpawned();
    const id = `e${++this.counter}`;
    return new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            "internal_error",
            `embedding call timed out after ${EMBED_CALL_TIMEOUT_MS}ms`,
          ),
        );
      }, EMBED_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ kind: "embed", id, texts });
    });
  }

  // --- internals -----------------------------------------------------------

  private ensureSpawned(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.spawning) return this.spawning;
    this.spawning = this.spawnWithBackoff().finally(() => {
      this.spawning = null;
    });
    return this.spawning;
  }

  private async spawnWithBackoff(): Promise<void> {
    if (Date.now() < this.nextRetryAt) {
      throw new AppError(
        "server_busy",
        `embedding worker is in backoff after ${this.consecutiveBootFailures} failed boot(s)`,
      );
    }
    try {
      await this.spawn();
      this.consecutiveBootFailures = 0;
      this.nextRetryAt = 0;
    } catch (err) {
      this.consecutiveBootFailures++;
      const delay = Math.min(
        BACKOFF_BASE_MS * 2 ** (this.consecutiveBootFailures - 1),
        BACKOFF_MAX_MS,
      );
      this.nextRetryAt = Date.now() + delay;
      log.warn(
        `embedding boot failed (${this.consecutiveBootFailures} in a row); ` +
          `backing off ${delay}ms: ${errMessage(err)}`,
      );
      throw err;
    }
  }

  private async spawn(): Promise<void> {
    const denoBin = await requireWorkerDeno();
    const entry = this.workerEntry();
    const modelsRoot = paths().modelsDir;

    const proc = new Deno.Command(denoBin, {
      args: [
        "run",
        "--no-prompt",
        "--no-check",
        "--quiet",
        `--allow-read=${modelsRoot},${paths().denoCacheDir}`,
        "--allow-env=ORT_LOG_LEVEL",
        entry,
        modelsRoot,
      ],
      env: { DENO_DIR: paths().denoCacheDir },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Windows-only: register with the kill-on-close job object so a hard
    // core crash doesn't leave this worker orphaned. No-op elsewhere.
    trackSidecarPid(proc.pid);

    this.proc = proc;
    this.writer = proc.stdin.getWriter();

    void this.pumpStdout(proc.stdout);
    void this.pumpStderr(proc.stderr);
    void proc.status.then((s) => {
      log.warn(`embedding subprocess exited (code=${s.code})`);
      this.failPending(new AppError("internal_error", "embedding subprocess exited"));
      // If the exit races the boot handshake, reject the boot promise too so the
      // spawn doesn't hang until the boot timeout.
      this.bootReject?.(new AppError("internal_error", "embedding subprocess exited during boot"));
      this.bootResolve = null;
      this.bootReject = null;
      this.proc = null;
      this.writer = null;
      this.ready = false;
    });

    // Settle on the first `ready` frame, on subprocess exit (above), or on a
    // hard timeout. No self-rescheduling poll: an earlier version rescheduled a
    // 50ms timer that kept firing for the whole process lifetime when boot never
    // completed.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.bootResolve = null;
        this.bootReject = null;
        reject(new Error("embedding worker boot timeout"));
      }, BOOT_TIMEOUT_MS);
      this.bootResolve = () => {
        clearTimeout(t);
        resolve();
      };
      this.bootReject = (err) => {
        clearTimeout(t);
        reject(err);
      };
    });
  }

  private send(frame: object): void {
    if (!this.writer) {
      throw new AppError("internal_error", "embedding subprocess not running");
    }
    // If stdin is already closed (worker crashed after `ready` but before
    // proc.status fired), the write rejects. Route it through failPending so the
    // embed that queued before we noticed the crash fails instead of hanging.
    this.writer.write(new TextEncoder().encode(JSON.stringify(frame) + "\n")).catch((err) => {
      this.failPending(
        err instanceof Error
          ? err
          : new AppError("internal_error", `embedding write failed: ${err}`),
      );
    });
  }

  private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handle(JSON.parse(line) as WorkerFrame);
        } catch {
          log.warn(`embedding: bad frame ${line}`);
        }
      }
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      log.warn(`[embedding/stderr] ${text.trimEnd()}`);
    }
  }

  private handle(frame: WorkerFrame): void {
    switch (frame.kind) {
      case "ready":
        this.ready = true;
        this.bootResolve?.();
        this.bootResolve = null;
        this.bootReject = null;
        return;
      case "embedded": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        const vectors = frame.vectorsBase64.map((b64) => {
          const bytes = base64ToBytes(b64);
          return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        });
        pending.resolve(vectors);
        return;
      }
      case "embed_err": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.reject(new AppError("provider_error", `embedding: ${frame.error}`));
        return;
      }
    }
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let _instance: EmbeddingController | null = null;
export function embeddingController(): EmbeddingController {
  if (!_instance) _instance = new EmbeddingController();
  return _instance;
}

export function __resetForTesting(): void {
  _instance = null;
}
