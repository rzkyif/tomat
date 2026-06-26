// Text-to-Speech synthesis core, shared by the /tts/synthesize route and the
// module broker's tts.speak op. Local mode routes through the speech sidecar's
// Kokoro engine (queued behind the single engine for fair multi-client
// behaviour); external mode posts to the configured OpenAI-compatible endpoint
// (tts.external.{baseUrl, apiKey, model, voice}) via /v1/audio/speech. Mirrors
// stt-transcribe.ts.

import { errMessage } from "@tomat/shared";
import OpenAI from "openai";
import { speechSpeak } from "../sidecars/speech.ts";
import { speechScheduler } from "./speech-scheduler.ts";
import { loadCoreSettings } from "./core-settings.ts";
import { getSecret } from "./secrets.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("tts");

/** Synthesize `text` to WAV bytes using the provider the settings select.
 *  `clientId` keys the local speech queue's per-client fairness (defaults to
 *  "core" for internal callers like the module broker). */
export async function synthesizeSpeech(
  text: string,
  voice?: string,
  speed?: number,
  clientId = "core",
): Promise<Uint8Array> {
  const settings = await loadCoreSettings();
  const provider = strSetting(settings, "tts.provider", "local");

  if (provider === "external") {
    const baseUrl = strSetting(settings, "tts.external.baseUrl", "");
    const model = strSetting(settings, "tts.external.model", "");
    if (!baseUrl || !model) {
      throw new AppError(
        "validation_error",
        "external TTS requires tts.external.baseUrl and tts.external.model",
      );
    }
    // Vault is authoritative; a plaintext value in settings.json is a
    // lower-precedence fallback (client routes keys to the vault, core redacts).
    const settingsKey = strSetting(settings, "tts.external.apiKey", "");
    const apiKey = (await getSecret("tts.external.apiKey")) || settingsKey || "";
    const selectedVoice = voice || strSetting(settings, "tts.external.voice", "alloy");
    const client = new OpenAI({ baseURL: baseUrl, apiKey: apiKey || "sk-tts", maxRetries: 0 });
    try {
      const startedAt = Date.now();
      log.info(`external synthesis starting (model ${model}, ${text.length} chars)`);
      const res = await client.audio.speech.create({
        model,
        voice: selectedVoice,
        input: text,
        response_format: "wav",
        ...(speed ? { speed } : {}),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      log.info(
        `external synthesis done in ${Date.now() - startedAt}ms (out ${bytes.length} bytes)`,
      );
      return bytes;
    } catch (err) {
      throw new AppError("provider_error", `external TTS failed: ${errMessage(err)}`);
    }
  }

  // Local mode: hit the speech sidecar through the speech scheduler so
  // concurrent multi-client requests queue fairly behind the single engine.
  return speechScheduler().schedule(clientId, () => speechSpeak(text, voice, speed));
}

function strSetting(s: Record<string, unknown>, k: string, def: string): string {
  const v = s[k];
  return typeof v === "string" ? v : def;
}
