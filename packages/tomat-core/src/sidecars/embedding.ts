// Host-side embedding controller. Spawns workers/embeddingWorker.ts as a
// Deno subprocess with minimal permissions, sends NDJSON embed frames over
// stdin, and parses base64-encoded Float32Array responses from stdout into
// Promises.
//
// Spawn flags:
//   deno run --allow-read=<models-dir> --allow-env=ORT_LOG_LEVEL
//            <core>/workers/embeddingWorker.ts <models-dir>
//
// The transformers/onnxruntime dependency (~340 MB) lives only inside this
// subprocess, keeping the main tomat-core binary lean. The subprocess is
// kept warm for the host's lifetime; respawn happens automatically if it
// crashes.

import { join } from "@std/path";
import { binPath } from "../paths.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { binaryName } from "../binaries/versions.ts";
import { trackSidecarPid } from "./jobctl.ts";

const log = getLogger("embedding");

type WorkerFrame =
  | { kind: "ready" }
  | { kind: "embedded"; id: string; vectorsBase64: string[] }
  | { kind: "embed_err"; id: string; error: string };

interface PendingEmbed {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
}

export class EmbeddingController {
  private proc: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private ready = false;
  private spawning: Promise<void> | null = null;
  private pending = new Map<string, PendingEmbed>();
  private counter = 0;

  private workerEntry(): string {
    // Resolved at runtime to escape `deno compile`'s static analyzer.
    // Source location is paths().workersDir (= ~/.tomat/core/workers in
    // prod, overridden to the in-repo source path during dev).
    return join(paths().workersDir, "embeddingWorker.ts");
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensureSpawned();
    const id = `e${++this.counter}`;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ kind: "embed", id, texts });
    });
  }

  // --- internals -----------------------------------------------------------

  private ensureSpawned(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.spawning) return this.spawning;
    this.spawning = this.spawn().finally(() => {
      this.spawning = null;
    });
    return this.spawning;
  }

  private async spawn(): Promise<void> {
    const denoBin = binPath(binaryName("deno"));
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
      this.failPending(
        new AppError("internal_error", "embedding subprocess exited"),
      );
      this.proc = null;
      this.writer = null;
      this.ready = false;
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("embedding worker boot timeout")),
        5_000,
      );
      const check = () => {
        if (this.ready) {
          clearTimeout(t);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private send(frame: object): void {
    if (!this.writer) {
      throw new AppError(
        "internal_error",
        "embedding subprocess not running",
      );
    }
    void this.writer.write(
      new TextEncoder().encode(JSON.stringify(frame) + "\n"),
    );
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
        return;
      case "embedded": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        const vectors = frame.vectorsBase64.map((b64) => {
          const bytes = base64ToBytes(b64);
          return new Float32Array(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength / 4,
          );
        });
        pending.resolve(vectors);
        return;
      }
      case "embed_err": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        pending.reject(
          new AppError("provider_error", `embedding: ${frame.error}`),
        );
        return;
      }
    }
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
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
