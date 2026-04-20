import { Elysia, t } from "elysia";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import * as path from "node:path";
import * as os from "node:os";
import { errorMessage, errorStatus, httpError } from "./httpError";

/** Single source of truth for the sidecar's bound address. The frontend's
 *  `src/lib/shared/network.ts` duplicates these values — keep both in sync
 *  if either changes. */
const SIDECAR_HOST = "127.0.0.1";
const SIDECAR_PORT = 7703;

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

// kokoro-js's `_validate_voice` only accepts the 28 English voices in its
// hardcoded VOICES allowlist (see node_modules/kokoro-js/dist/kokoro.cjs),
// but the package ships 56 .bin tensors covering Japanese (jf_*/jm_*),
// Mandarin (zf_*/zm_*) and others. The model itself handles any voice whose
// tensor file resolves; only the validator stands in the way. Upstream has
// no API to extend the list, so we relax the validator here. Revisit if a
// future kokoro-js exposes the full catalog directly.
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

// Drops the model and releases the underlying ORT sessions. Without
// model.dispose() the native onnxruntime-node allocations stay live even
// after the JS reference is gone, so toggling TTS off would never visibly
// shrink the sidecar's RSS. kokoro-js also keeps a module-internal voice
// tensor cache (~500 KB per voice, capped at ~27 MB if every voice was
// played) that we can't reach to clear; that residue is the price of not
// vendoring the package.
async function unloadModel(): Promise<void> {
  const model = tts;
  tts = null;
  loadPromise = null;
  // Wait for any in-flight generate() before disposing - tearing down
  // sessions mid-run would crash ORT.
  await inflight.catch(() => {});
  if (model) {
    try {
      // PreTrainedModel.dispose() walks model.sessions and calls
      // session.handler.dispose() on each, releasing the native ORT
      // sessions. Without this the C++ sessions stay alive forever and a
      // re-load would stack a fresh session on top of the old one.
      await (model.model as { dispose?: () => Promise<unknown> }).dispose?.();
    } catch (err) {
      console.error("[tts] dispose failed:", err);
    }
  }
  // Bun.gc(true) forces a synchronous GC; globalThis.gc only exists with
  // Node's --expose-gc, which Bun doesn't honor. Note the OS won't
  // necessarily reclaim the freed pages - libc typically keeps them in the
  // process's heap pool. RSS therefore won't visibly drop, but per-cycle
  // growth is bounded since the native sessions are actually torn down.
  try {
    Bun.gc(true);
  } catch {
    /* ignore */
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
  // Centralized error formatter: every route throws; this translates the
  // thrown value into a uniform `{ error, status }` JSON response with the
  // right HTTP status, preserving CORS headers. Avoids scattering
  // per-route try/catch boilerplate and divergent error shapes.
  .onError(({ error, set }) => {
    const status = errorStatus(error);
    set.status = status;
    Object.assign(set.headers, CORS_HEADERS);
    return { error: errorMessage(error), status };
  })
  .options("/*", () => new Response(null, { status: 204, headers: CORS_HEADERS }))
  .get("/api/health", () => {
    // Liveness + component readiness. Callers (the Rust backend's
    // `start_bun_sidecar` poll, frontend status chips) gate on "status: ok"
    // but the nested fields let tooling report finer state.
    return {
      status: "ok",
      tts: tts ? "loaded" : loadPromise ? "loading" : "idle",
    };
  })
  .get("/api/test", () => {
    return { status: "ok" };
  })
  .post(
    "/api/tts/load",
    async () => {
      await ensureLoaded();
      return { status: "ok" };
    },
    { body: t.Optional(t.Object({})) },
  )
  .post("/api/tts/unload", async () => {
    await unloadModel();
    return { status: "ok" };
  })
  .post(
    "/api/tts/synthesize",
    async ({ body }) => {
      const model = tts;
      if (!model) throw httpError(409, "TTS not loaded");
      const text = body.text?.trim();
      if (!text) throw httpError(400, "Empty text");
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
      await task;
      if (!result) throw httpError(500, "No audio produced");
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
  .listen({ port: SIDECAR_PORT, hostname: SIDECAR_HOST });

console.log(`Bun sidecar is running at ${app.server?.hostname}:${app.server?.port}`);

export type App = typeof app;
