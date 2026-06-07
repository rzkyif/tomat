// TTS subprocess: hosts kokoro-js, reads NDJSON frames from stdin, writes
// NDJSON frames to stdout. Spawned by sidecars/tts.ts with minimal Deno
// permissions (--allow-read=<models-dir>, --allow-env=ORT_LOG_LEVEL).
//
// Frame protocol:
//   in  -> { kind: "load" }
//   out <- { kind: "load_ok" } | { kind: "load_err", error }
//   in  -> { kind: "synthesize", id, text, voice, speed }
//   out <- { kind: "audio", id, sampleRate, pcmBase64 }
//        | { kind: "synth_err", id, error }
//   in  -> { kind: "unload" }
//   out <- { kind: "unload_ok" }
//
// The host wraps the PCM in a WAV header before serving to clients; this
// keeps subprocess output compact.

// Full `npm:` specifiers (not the workspace import-map aliases) so this
// file can run standalone from ~/.tomat/core/workers/ after install, with
// no deno.json nearby. Keep versions pinned in lockstep with tomat-core's
// own deno.json import map.
import { env } from "npm:@huggingface/transformers@^4.2.0";
import { errMessage } from "@tomat/shared";
import { KokoroTTS } from "npm:kokoro-js@^1.2.1";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// kokoro-js's _validate_voice rejects voices outside its 28-English allowlist
// even though the shipped weights cover 56 voices (incl. Japanese, Mandarin,
// etc.). Patch the validator to accept any non-empty string. Mirrors the
// existing Bun sidecar fix.
(KokoroTTS as unknown as { prototype: Record<string, unknown> }).prototype._validate_voice =
  function (voice: string): string {
    if (typeof voice !== "string" || voice.length === 0) {
      throw new Error("Voice must be a non-empty string");
    }
    return voice.charAt(0);
  };

type In =
  | { kind: "load" }
  | {
      kind: "synthesize";
      id: string;
      text: string;
      voice?: string;
      speed?: number;
    }
  | { kind: "unload" }
  | { kind: "ready" }; // ignored

type Out =
  | { kind: "ready" }
  | { kind: "load_ok" }
  | { kind: "load_err"; error: string }
  | { kind: "audio"; id: string; sampleRate: number; pcmBase64: string }
  | { kind: "synth_err"; id: string; error: string }
  | { kind: "unload_ok" };

function send(frame: Out): void {
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
}

let tts: KokoroTTS | null = null;
let loadInflight: Promise<void> | null = null;
let synthChain: Promise<void> = Promise.resolve();

function configureEnv(modelsRoot: string): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsRoot;
  env.cacheDir = modelsRoot;
  (env as unknown as { useBrowserCache?: boolean }).useBrowserCache = false;
}

async function load(): Promise<void> {
  if (tts) return;
  if (loadInflight) return loadInflight;
  loadInflight = (async () => {
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      device: "cpu",
    });
  })();
  try {
    await loadInflight;
  } finally {
    loadInflight = null;
  }
}

async function unload(): Promise<void> {
  const model = tts;
  tts = null;
  loadInflight = null;
  await synthChain.catch(() => {});
  if (model) {
    try {
      await (model.model as { dispose?: () => Promise<unknown> }).dispose?.();
    } catch {
      /* ignore */
    }
  }
}

async function synthesize(
  id: string,
  text: string,
  voice: string | undefined,
  speed: number | undefined,
): Promise<void> {
  const model = tts;
  if (!model) {
    send({ kind: "synth_err", id, error: "tts not loaded" });
    return;
  }
  const clampedSpeed = Math.max(0.25, Math.min(3, speed ?? 1));
  let result: { audio: Float32Array; sampling_rate: number } | null = null;
  const task = synthChain.then(async () => {
    result = (await model.generate(text, {
      voice: (voice ?? "af_bella") as never,
      speed: clampedSpeed,
    })) as unknown as { audio: Float32Array; sampling_rate: number };
  });
  synthChain = task.catch(() => {});
  try {
    await task;
  } catch (err) {
    send({
      kind: "synth_err",
      id,
      error: errMessage(err),
    });
    return;
  }
  const audioResult = result as { audio: Float32Array; sampling_rate: number } | null;
  if (!audioResult) {
    send({ kind: "synth_err", id, error: "no audio produced" });
    return;
  }
  const pcmBase64 = floatArrayToBase64Pcm16(audioResult.audio);
  send({ kind: "audio", id, sampleRate: audioResult.sampling_rate, pcmBase64 });
}

function floatArrayToBase64Pcm16(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < arr.length; i++) {
    const s = Math.max(-1, Math.min(1, arr[i]));
    view.setInt16(i * 2, (s < 0 ? s * 0x8000 : s * 0x7fff) | 0, true);
  }
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    );
  }
  return btoa(bin);
}

// --- stdin loop -----------------------------------------------------------

async function main(): Promise<void> {
  const modelsRoot = Deno.args[0];
  if (!modelsRoot) {
    Deno.stderr.writeSync(new TextEncoder().encode("missing modelsRoot arg\n"));
    Deno.exit(1);
  }
  configureEnv(modelsRoot);
  send({ kind: "ready" });

  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: In;
      try {
        frame = JSON.parse(line) as In;
      } catch {
        Deno.stderr.writeSync(new TextEncoder().encode(`bad frame: ${line}\n`));
        continue;
      }
      await dispatch(frame);
    }
  }
}

async function dispatch(frame: In): Promise<void> {
  if (frame.kind === "load") {
    try {
      await load();
      send({ kind: "load_ok" });
    } catch (err) {
      send({
        kind: "load_err",
        error: errMessage(err),
      });
    }
  } else if (frame.kind === "synthesize") {
    await synthesize(frame.id, frame.text, frame.voice, frame.speed);
  } else if (frame.kind === "unload") {
    await unload();
    send({ kind: "unload_ok" });
  }
}

if (import.meta.main) {
  await main();
}
