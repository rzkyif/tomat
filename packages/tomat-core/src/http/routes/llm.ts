// Single-shot LLM utility endpoints. These are non-streaming wrappers used
// by the client for short post-processing tasks (STT autocorrect, STT
// merge) so that no LLM traffic ever bypasses core — same provider
// resolution + secrets vault as the streaming chat path.
//
// Routes:
//   POST /api/v1/llm/autocorrect  { text }                  → { text }
//   POST /api/v1/llm/merge        { existing, next }        → { text }
//
// Prompts are user-overridable via core settings:
//   prompts.autocorrectPrompt        (default: DEFAULT_AUTOCORRECT_PROMPT)
//   prompts.mergeTranscriptionPrompt (default: DEFAULT_MERGE_TRANSCRIPTION_PROMPT)

import { Hono } from "hono";
import {
  DEFAULT_AUTOCORRECT_PROMPT,
  DEFAULT_MERGE_TRANSCRIPTION_PROMPT,
} from "@tomat/shared";
import { loadCoreSettings } from "../../services/coreSettings.ts";
import { resolveEndpoint } from "../../services/endpointResolver.ts";
import { singleShot } from "../../services/singleShot.ts";
import { AppError } from "../../shared/errors.ts";
import { bearerMiddleware } from "../middleware/auth.ts";

export function llmRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.post("/autocorrect", async (c) => {
    const body = (await readJson(c)) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.length === 0) {
      throw new AppError("validation_error", "body must be { text: string }");
    }
    const settings = await loadCoreSettings();
    const systemPrompt =
      strSetting(settings, "prompts.autocorrectPrompt", "") ||
      DEFAULT_AUTOCORRECT_PROMPT;
    const endpoint = await resolveEndpoint(settings, "default");
    const text = await singleShot({
      systemPrompt,
      userMessage: body.text,
      endpoint,
      overrides: { temperature: 0.2 },
    });
    return c.json({ text });
  });

  r.post("/merge", async (c) => {
    const body = (await readJson(c)) as { existing?: unknown; next?: unknown };
    if (
      typeof body.existing !== "string" || typeof body.next !== "string" ||
      body.next.length === 0
    ) {
      throw new AppError(
        "validation_error",
        "body must be { existing: string, next: string }",
      );
    }
    const settings = await loadCoreSettings();
    const systemPrompt =
      strSetting(settings, "prompts.mergeTranscriptionPrompt", "") ||
      DEFAULT_MERGE_TRANSCRIPTION_PROMPT;
    const endpoint = await resolveEndpoint(settings, "default");
    const userMessage =
      `<existing>\n${body.existing}\n</existing>\n<new>\n${body.next}\n</new>`;
    const text = await singleShot({
      systemPrompt,
      userMessage,
      endpoint,
      overrides: { temperature: 0.2 },
    });
    return c.json({ text });
  });

  return r;
}

function strSetting(
  s: Record<string, unknown>,
  key: string,
  def: string,
): string {
  const v = s[key];
  return typeof v === "string" ? v : def;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}
