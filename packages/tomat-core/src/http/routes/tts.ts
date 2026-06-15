import { Hono } from "hono";
import { sidecarManager } from "../../sidecars/manager.ts";
import { loadCoreSettings } from "../../services/core-settings.ts";
import { loadModelCatalog } from "../../models/catalog.ts";
import { selectedTtsVoices } from "../../models/tts.ts";
import { speechSpeak } from "../../sidecars/speech.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

export function ttsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  // TTS loads and unloads with the speech sidecar (gated on tts.enabled in
  // services/sidecar-boot.ts), so explicit prewarm / unload are no-ops kept
  // for the client's existing calls.
  r.post("/load", (c) => c.body(null, 204));
  r.post("/unload", (c) => c.body(null, 204));

  r.post("/synthesize", async (c) => {
    const body = (await readJson(c)) as {
      text?: string;
      voice?: string;
      speed?: number;
    };
    if (!body.text || typeof body.text !== "string") {
      throw new AppError("validation_error", "text required");
    }
    const wav = await speechSpeak(body.text, body.voice, body.speed);
    return new Response(wav.buffer as ArrayBuffer, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    });
  });

  // The voices of the currently-selected TTS model, so the client's voice
  // dropdown matches the model in use. Reads tts.modelType + tts.modelPath
  // against the signed catalog.
  r.get("/voices", async (c) => {
    const [catalog, settings] = await Promise.all([loadModelCatalog(), loadCoreSettings()]);
    const voices = selectedTtsVoices(
      catalog,
      String(settings["tts.modelType"] ?? "kokoro"),
      String(settings["tts.modelPath"] ?? ""),
    );
    return c.json(voices);
  });

  // Map the speech sidecar's lifecycle onto the {loaded, loading} shape the
  // client polls: TTS is "loaded" once the sidecar is Running with tts enabled.
  r.get("/status", async (c) => {
    const snap = sidecarManager().status("speech");
    const settings = await loadCoreSettings();
    const ttsOn = settings["tts.enabled"] === true;
    return c.json({
      loaded: ttsOn && snap.status === "Running",
      loading: ttsOn && snap.status === "Loading",
    });
  });

  return r;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
