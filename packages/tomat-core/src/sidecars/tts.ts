// Host-side TTS controller. Spawns workers/tts-worker.ts as a Deno subprocess
// with minimal permissions, sends NDJSON load/synthesize/unload frames over
// stdin, and parses NDJSON responses from stdout into Promises.
//
// Spawn flags:
//   deno run --allow-read=<models-dir> --allow-env=ORT_LOG_LEVEL
//            <core>/workers/tts-worker.ts <models-dir>

import { join } from "@std/path";
import { binPath } from "../paths.ts";
import { paths } from "../paths.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { binaryName } from "../binaries/versions.ts";
import { trackSidecarPid } from "./jobctl.ts";

const log = getLogger("tts");

type WorkerFrame =
  | { kind: "ready" }
  | { kind: "load_ok" }
  | { kind: "load_err"; error: string }
  | { kind: "audio"; id: string; sampleRate: number; pcmBase64: string }
  | { kind: "synth_err"; id: string; error: string };

interface PendingSynth {
  resolve: (out: { sampleRate: number; pcm: Uint8Array }) => void;
  reject: (err: Error) => void;
}

export class TtsController {
  private proc: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private ready = false;
  private loaded = false;
  private loading = false;
  private loadWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private synthsInFlight = new Map<string, PendingSynth>();
  private synthCounter = 0;

  private workerEntry(): string {
    // Resolved at runtime to escape `deno compile`'s static analyzer.
    // See sidecars/embedding.ts for the full rationale.
    return join(paths().workersDir, "tts-worker.ts");
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // Both the first caller and any concurrent callers push to loadWaiters
    // and await the same handle/load lifecycle. A spawn or send failure in
    // the first caller must reject every queued waiter and reset `loading`
    // so a later retry can re-spawn.
    const wait = new Promise<void>((resolve, reject) => {
      this.loadWaiters.push({ resolve, reject });
    });
    if (!this.loading) {
      this.loading = true;
      try {
        if (!this.proc) await this.spawn();
        this.send({ kind: "load" });
      } catch (err) {
        this.loading = false;
        this.failPending(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    }
    await wait;
  }

  // Kill the subprocess outright. TTS lives in its own process (unlike the
  // old Bun bundle where TTS shared a process with tools and a `kill` would
  // have taken tools down too), so the simplest way to release ORT's native
  // ONNX sessions back to the OS is to terminate the worker. State is reset
  // synchronously so the next `synthesize()` cleanly respawns. The
  // Promise<void> return keeps the signature symmetrical with the other
  // public methods so callers can keep their `await ttsController().unload()`.
  unload(): Promise<void> {
    if (!this.proc) return Promise.resolve();
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    this.proc = null;
    this.writer = null;
    this.ready = false;
    this.loaded = false;
    this.loading = false;
    this.failPending(new AppError("internal_error", "tts subprocess killed"));
    return Promise.resolve();
  }

  async synthesize(
    text: string,
    voice?: string,
    speed?: number,
  ): Promise<{ sampleRate: number; pcm: Uint8Array }> {
    await this.ensureLoaded();
    const id = `s${++this.synthCounter}`;
    return new Promise<{ sampleRate: number; pcm: Uint8Array }>((resolve, reject) => {
      this.synthsInFlight.set(id, { resolve, reject });
      this.send({ kind: "synthesize", id, text, voice, speed });
    });
  }

  status(): { loaded: boolean; loading: boolean } {
    return { loaded: this.loaded, loading: this.loading };
  }

  // --- internals -----------------------------------------------------------

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
      log.warn(`tts subprocess exited (code=${s.code})`);
      this.failPending(new AppError("internal_error", "tts subprocess exited"));
      this.proc = null;
      this.writer = null;
      this.ready = false;
      this.loaded = false;
    });

    // Wait for the worker to send its initial "ready" frame.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("tts worker boot timeout")), 5_000);
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
      throw new AppError("internal_error", "tts subprocess not running");
    }
    // If stdin is already closed (worker crashed after `ready` but before
    // proc.status fired failPending), the write rejects. Route it through
    // failPending so the pending load/synth that queued before we noticed
    // the crash also fails. Otherwise it hangs forever.
    this.writer.write(new TextEncoder().encode(JSON.stringify(frame) + "\n")).catch((err) => {
      this.failPending(
        err instanceof Error ? err : new AppError("internal_error", `tts write failed: ${err}`),
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
          const frame = JSON.parse(line) as WorkerFrame;
          this.handle(frame);
        } catch {
          log.warn(`tts: bad frame ${line}`);
        }
      }
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      log.warn(`[tts/stderr] ${text.trimEnd()}`);
    }
  }

  private handle(frame: WorkerFrame): void {
    switch (frame.kind) {
      case "ready":
        this.ready = true;
        return;
      case "load_ok": {
        this.loaded = true;
        this.loading = false;
        for (const w of this.loadWaiters) w.resolve();
        this.loadWaiters = [];
        return;
      }
      case "load_err": {
        this.loading = false;
        const err = new AppError("provider_error", `tts load failed: ${frame.error}`);
        for (const w of this.loadWaiters) w.reject(err);
        this.loadWaiters = [];
        return;
      }
      case "audio": {
        const pending = this.synthsInFlight.get(frame.id);
        if (!pending) return;
        this.synthsInFlight.delete(frame.id);
        pending.resolve({
          sampleRate: frame.sampleRate,
          pcm: base64ToBytes(frame.pcmBase64),
        });
        return;
      }
      case "synth_err": {
        const pending = this.synthsInFlight.get(frame.id);
        if (!pending) return;
        this.synthsInFlight.delete(frame.id);
        pending.reject(new AppError("provider_error", `tts: ${frame.error}`));
        return;
      }
    }
  }

  private failPending(err: Error): void {
    for (const w of this.loadWaiters) w.reject(err);
    this.loadWaiters = [];
    for (const p of this.synthsInFlight.values()) p.reject(err);
    this.synthsInFlight.clear();
  }
}

// Wraps caller-supplied PCM in a standard 16-bit mono WAV header.
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.length;
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);
  buf.set(pcm, 44);
  return buf;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let _instance: TtsController | null = null;
export function ttsController(): TtsController {
  if (!_instance) _instance = new TtsController();
  return _instance;
}

export function __resetForTesting(): void {
  _instance = null;
}
