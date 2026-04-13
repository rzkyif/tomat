import { Elysia, t } from "elysia";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Kokoro TTS runtime
// ---------------------------------------------------------------------------
// Transformers.js is allowed to read from the shared Tomat model cache but
// must never reach out to the network - all required files are pre-fetched by
// the frontend's download flow before /api/tts/load is called.
const homeDir = os.homedir();
const LOCAL_MODEL_ROOT = path.join(homeDir, ".tomat", "models");
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = LOCAL_MODEL_ROOT;
env.cacheDir = LOCAL_MODEL_ROOT;
(env as unknown as { useBrowserCache?: boolean }).useBrowserCache = false;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// kokoro-js ships voice tensors for every language under the 82M-v1 ONNX repo
// but gates them behind a hardcoded allow-list of English voices. We still
// want the full catalog exposed, so we relax validation here - the bundled
// `voices/` directory supplies the tensor bytes; the model itself handles
// any voice the user selects.
(KokoroTTS as unknown as { prototype: Record<string, unknown> }).prototype._validate_voice =
  function (voice: string): string {
    if (typeof voice !== "string" || voice.length === 0) {
      throw new Error("Voice must be a non-empty string");
    }
    return voice.charAt(0);
  };

let tts: KokoroTTS | null = null;
let loadPromise: Promise<void> | null = null;
// Chain inference so concurrent synthesize calls queue instead of racing inside ORT.
let inflight: Promise<void> = Promise.resolve();

async function ensureLoaded(): Promise<void> {
  if (tts) return;
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      device: "cpu",
    });
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function unloadModel(): void {
  tts = null;
  const g = globalThis as unknown as { gc?: () => void };
  if (typeof g.gc === "function") {
    try {
      g.gc();
    } catch {
      /* ignore */
    }
  }
}

function wavFromPcm(pcm: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// HTTP server (loopback only)
// ---------------------------------------------------------------------------
// The webview's origin (tauri.localhost / http://localhost:1420 in dev) is not
// the same origin as 127.0.0.1:7703, so every request from Svelte is
// cross-origin. We permit any origin because the socket is already bound to
// loopback only - no external host can reach the sidecar in the first place.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export const app = new Elysia()
  .onRequest(({ set }) => {
    Object.assign(set.headers, CORS_HEADERS);
  })
  .options("/*", () => new Response(null, { status: 204, headers: CORS_HEADERS }))
  .get("/api/health", () => {
    return { status: "ok" };
  })
  .get("/api/test", () => {
    return { status: "ok" };
  })
  .post(
    "/api/tts/load",
    async ({ set }) => {
      try {
        await ensureLoaded();
        return { status: "ok" };
      } catch (err) {
        console.error("[tts] load failed:", err);
        set.status = 500;
        return { status: "error", error: String(err) };
      }
    },
    { body: t.Optional(t.Object({})) },
  )
  .post("/api/tts/unload", () => {
    unloadModel();
    return { status: "ok" };
  })
  .post(
    "/api/tts/synthesize",
    async ({ body, set }) => {
      const model = tts;
      if (!model) {
        set.status = 409;
        return new Response(JSON.stringify({ error: "TTS not loaded" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      const text = body.text?.trim();
      if (!text) {
        set.status = 400;
        return new Response(JSON.stringify({ error: "Empty text" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const voice = body.voice || "af_bella";
      const speed = Math.max(0.25, Math.min(3, body.speed ?? 1));

      let result: { audio: Float32Array; sampling_rate: number } | null = null;
      const task = inflight.then(async () => {
        // The generate() signature is narrowed to the English voice literal
        // union, but our monkey-patched `_validate_voice` accepts any string.
        result = (await model.generate(text, {
          voice: voice as never,
          speed,
        })) as unknown as {
          audio: Float32Array;
          sampling_rate: number;
        };
      });
      inflight = task.catch(() => {});
      try {
        await task;
      } catch (err) {
        console.error("[tts] synth failed:", err);
        set.status = 500;
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!result) {
        set.status = 500;
        return new Response(JSON.stringify({ error: "No audio produced" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      const wav = wavFromPcm(
        (result as { audio: Float32Array }).audio,
        (result as { sampling_rate: number }).sampling_rate,
      );
      return new Response(new Uint8Array(wav), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    },
    {
      body: t.Object({
        text: t.String(),
        voice: t.Optional(t.String()),
        speed: t.Optional(t.Number()),
      }),
    },
  )
  .listen({ port: 7703, hostname: "127.0.0.1" });

console.log(`Bun sidecar is running at ${app.server?.hostname}:${app.server?.port}`);

export type App = typeof app;
