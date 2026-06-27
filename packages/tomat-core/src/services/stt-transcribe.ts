// Speech-to-Text transcription core, shared by the /stt/transcribe route
// and the module broker's stt.transcribe op. Local mode posts the audio to
// the speech sidecar (tomat-core-speech /transcribe); external mode posts to
// the configured OpenAI-compatible endpoint (stt.external.{baseUrl, apiKey,
// model}).

import { errMessage } from "@tomat/shared";
import OpenAI from "openai";
import { speechTranscribe } from "../sidecars/speech.ts";
import { speechScheduler } from "./speech-scheduler.ts";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";
import { getSecret } from "./secrets.ts";
import { strSetting } from "./settings-access.ts";

const log = getLogger("stt");

/** Transcribe `audio` using the provider the settings select. `signal`
 *  bounds the local-sidecar call on top of the built-in timeout (callers
 *  pass their request-abort signal; omit for the broker path). `clientId`
 *  keys the local speech queue's per-client fairness (defaults to "core" for
 *  internal callers like the module broker). */
export async function transcribeAudio(
  settings: Record<string, unknown>,
  audio: File,
  language: string | undefined,
  signal?: AbortSignal,
  clientId = "core",
): Promise<string> {
  const provider = strSetting(settings, "stt.provider", "local");

  if (provider === "external") {
    const baseUrl = strSetting(settings, "stt.external.baseUrl", "");
    const model = strSetting(settings, "stt.external.model", "");
    if (!baseUrl || !model) {
      throw new AppError(
        "validation_error",
        "external STT requires stt.external.baseUrl and stt.external.model",
      );
    }
    // Vault is authoritative; a plaintext value in settings.json is a
    // lower-precedence fallback (client routes keys to the vault, and core
    // redacts them from GET).
    const settingsKey = strSetting(settings, "stt.external.apiKey", "");
    const apiKey = (await getSecret("stt.external.apiKey")) || settingsKey || "";
    // Keep the SDK's default timeout (10 minutes). Never pass `timeout: 0`:
    // the SDK treats it as a literal 0ms deadline and aborts every request
    // instantly with "Request timed out".
    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "sk-stt",
      maxRetries: 0,
    });
    try {
      const startedAt = Date.now();
      log.info(`external transcription starting (audio ${audio.size} bytes, model ${model})`);
      const res = await client.audio.transcriptions.create({
        model,
        file: audio,
        ...(language ? { language } : {}),
        response_format: "json",
      });
      const text = (res as { text?: string }).text ?? "";
      log.info(
        `external transcription done in ${Date.now() - startedAt}ms ` +
          `(audio ${audio.size} bytes, out ${text.length} chars)`,
      );
      return text;
    } catch (err) {
      throw new AppError("provider_error", `external STT failed: ${errMessage(err)}`);
    }
  }

  // Local mode: hit the speech sidecar through the speech scheduler so
  // concurrent multi-client requests queue fairly behind the single engine.
  // speechTranscribe bounds the upstream call and cancels it when the caller
  // aborts, so neither a wedged sidecar nor an abandoned request keeps the
  // Whisper inference running indefinitely. The resident model auto-detects the
  // spoken language, so the `language` hint applies to the external provider
  // only.
  const startedAt = Date.now();
  log.info(`local transcription starting (audio ${audio.size} bytes)`);
  const text = await speechScheduler().schedule(clientId, () => speechTranscribe(audio, signal));
  log.info(
    `local transcription done in ${Date.now() - startedAt}ms ` +
      `(audio ${audio.size} bytes, out ${text.length} chars)`,
  );
  return text;
}
