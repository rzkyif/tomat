import { Hono } from "hono";
import { ttsGroup } from "@tomat/shared";
import { sidecarManager } from "../../sidecars/manager.ts";
import { loadCoreSettings } from "../../services/core-settings.ts";
import { speechSpeak } from "../../sidecars/speech.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

// Full Kokoro voice catalog, derived once from the shared settings schema
// so the dropdown and the /voices REST endpoint stay in lock-step.
const VOICE_CATALOG: Array<{ id: string; label: string; lang: string }> = (() => {
  for (const section of ttsGroup.sections) {
    for (const field of section.fields) {
      if (
        field.id === "tts.voice" &&
        field.type === "select" &&
        "options" in field &&
        field.options
      ) {
        return field.options.map((o: { value: string | number; label: string }) => ({
          id: String(o.value),
          label: o.label,
          lang: langFromVoiceId(String(o.value)),
        }));
      }
    }
  }
  return [];
})();

// Voice IDs are `<region><gender>_<name>`, e.g. `af_bella` (American Female
// Bella) or `jm_kumo` (Japanese Male Kumo). The first letter encodes the
// language family.
function langFromVoiceId(id: string): string {
  switch (id[0]) {
    case "a":
      return "en-us";
    case "b":
      return "en-gb";
    case "j":
      return "ja";
    case "z":
      return "zh";
    case "e":
      return "es";
    case "f":
      return "fr";
    case "h":
      return "hi";
    case "i":
      return "it";
    case "p":
      return "pt";
    default:
      return "en";
  }
}

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

  r.get("/voices", (c) => c.json(VOICE_CATALOG));

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
