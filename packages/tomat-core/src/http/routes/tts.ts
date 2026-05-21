import { Hono } from "hono";
import { ttsGroup } from "@tomat/shared";
import { pcmToWav, ttsController } from "../../sidecars/tts.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

// Full Kokoro voice catalog, derived once from the shared settings schema
// so the dropdown and the /voices REST endpoint stay in lock-step.
const VOICE_CATALOG: Array<{ id: string; label: string; lang: string }> =
  (() => {
    for (const section of ttsGroup.sections) {
      for (const field of section.fields) {
        if (
          field.id === "tts.voice" && field.type === "select" &&
          "options" in field && field.options
        ) {
          return field.options.map((
            o: { value: string | number; label: string },
          ) => ({
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

  r.post("/load", async (c) => {
    await ttsController().ensureLoaded();
    return c.body(null, 204);
  });

  r.post("/unload", async (c) => {
    await ttsController().unload();
    return c.body(null, 204);
  });

  r.post("/synthesize", async (c) => {
    const body = (await readJson(c)) as {
      text?: string;
      voice?: string;
      speed?: number;
    };
    if (!body.text || typeof body.text !== "string") {
      throw new AppError("validation_error", "text required");
    }
    const { sampleRate, pcm } = await ttsController().synthesize(
      body.text,
      body.voice,
      body.speed,
    );
    const wav = pcmToWav(pcm, sampleRate);
    return new Response(wav.buffer as ArrayBuffer, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    });
  });

  r.get("/voices", (c) => c.json(VOICE_CATALOG));

  r.get("/status", (c) => c.json(ttsController().status()));

  return r;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
