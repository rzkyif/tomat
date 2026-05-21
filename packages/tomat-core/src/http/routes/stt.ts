// STT routes. Local mode posts the audio to the whisper-server sidecar;
// external mode posts to a configured OpenAI-compatible transcription
// endpoint (stt.external.{baseUrl, apiKey, model}).
//
// The sidecar manager owns whether whisper-server is actually running
// (boot wiring lives in services/sidecarBoot.ts).

import { Hono } from "hono";
import OpenAI from "openai";
import { sidecarManager } from "../../sidecars/manager.ts";
import { loadCoreSettings } from "../../services/coreSettings.ts";
import { getSecret } from "../../services/secrets.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

export function sttRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.post("/transcribe", async (c) => {
    const form = await c.req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      throw new AppError("validation_error", "audio file required");
    }
    const language = form.get("language");
    const languageStr = typeof language === "string" && language.length > 0
      ? language
      : undefined;
    const settings = await loadCoreSettings();
    const provider = strSetting(settings, "stt.provider", "local") as
      | "local"
      | "external";

    if (provider === "external") {
      const baseUrl = strSetting(settings, "stt.external.baseUrl", "");
      const model = strSetting(settings, "stt.external.model", "");
      if (!baseUrl || !model) {
        throw new AppError(
          "validation_error",
          "external STT requires stt.external.baseUrl and stt.external.model",
        );
      }
      const settingsKey = strSetting(settings, "stt.external.apiKey", "");
      const apiKey = settingsKey ||
        (await getSecret("stt.external.apiKey")) || "";
      const client = new OpenAI({
        baseURL: baseUrl,
        apiKey: apiKey || "sk-stt",
        maxRetries: 0,
        timeout: 0,
      });
      try {
        const res = await client.audio.transcriptions.create({
          model,
          file: audio,
          ...(languageStr ? { language: languageStr } : {}),
          response_format: "json",
        });
        return c.json({ text: (res as { text?: string }).text ?? "" });
      } catch (err) {
        throw new AppError(
          "provider_error",
          `external STT failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Local mode: hit the whisper-server sidecar.
    const host = strSetting(settings, "stt.host", "127.0.0.1");
    const port = strSetting(settings, "stt.port", "7702");
    const upstream = `http://${host}:${port}/inference`;
    const upstreamForm = new FormData();
    upstreamForm.set("file", audio);
    if (languageStr) upstreamForm.set("language", languageStr);
    upstreamForm.set("response-format", "json");
    let res: Response;
    try {
      res = await fetch(upstream, { method: "POST", body: upstreamForm });
    } catch (err) {
      throw new AppError(
        "server_unavailable",
        `whisper-server not reachable at ${upstream}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    if (!res.ok) {
      throw new AppError("provider_error", `whisper-server HTTP ${res.status}`);
    }
    const body = await res.json() as { text?: string };
    return c.json({ text: body.text ?? "" });
  });

  r.get("/status", (c) => {
    const snap = sidecarManager().status("whisper");
    return c.json({
      provider: "local",
      running: snap.status === "Running",
    });
  });

  return r;
}

function strSetting(
  s: Record<string, unknown>,
  k: string,
  def: string,
): string {
  const v = s[k];
  return typeof v === "string" ? v : def;
}
