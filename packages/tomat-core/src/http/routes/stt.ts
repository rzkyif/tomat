// STT routes. Transcription provider branching (local speech sidecar vs
// external OpenAI-compatible endpoint) lives in services/stt-transcribe.ts,
// shared with the module broker's stt.transcribe op.
//
// The sidecar manager owns whether the speech sidecar is actually running
// (boot wiring lives in services/sidecar-boot.ts).

import { Hono } from "hono";
import { sidecarManager } from "../../sidecars/manager.ts";
import { loadCoreSettings } from "../../services/core-settings.ts";
import { transcribeAudio } from "../../services/stt-transcribe.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware, requireClient } from "../middleware/auth.ts";

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
    const languageStr = typeof language === "string" && language.length > 0 ? language : undefined;
    const settings = await loadCoreSettings();
    // The request-abort signal cancels the upstream inference if the client
    // disconnects mid-decode.
    const text = await transcribeAudio(
      settings,
      audio,
      languageStr,
      c.req.raw.signal,
      requireClient(c).id,
    );
    return c.json({ text });
  });

  r.get("/status", (c) => {
    const snap = sidecarManager().status("speech");
    return c.json({
      provider: "local",
      running: snap.status === "Running",
    });
  });

  return r;
}
