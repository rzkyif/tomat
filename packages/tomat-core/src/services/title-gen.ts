// Async title generation for new sessions.
//
// After a session's first turn completes (user message + first assistant
// reply), we ask the configured LLM for a short title and PATCH it onto
// the session. The client picks it up via the `session.updated` WS frame
// with op="title_changed".
//
// Designed to be fire-and-forget. Failures are logged but never surface
// to the user. The session keeps its empty title; another turn can retry.
//
// The system prompt is the user-overridable `prompts.titleGenerationPrompt`
// setting (default in @tomat/shared/domain/prompts.ts).

import type OpenAI from "openai";
import { DEFAULT_TITLE_GENERATION_PROMPT, errMessage } from "@tomat/shared";
import { sessionsRepo } from "./sessions-store.ts";
import { loadCoreSettings } from "./core-settings.ts";
import { type LlmRequest, streamChatCompletion } from "./llm-provider.ts";
import { resolveEndpoint } from "./endpoint-resolver.ts";
import { wsHub } from "../ws/hub.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("title-gen");

// Hard cap to keep titles from blowing up the UI / DB. The LLM is asked
// for ~5 words but adversarial / runaway models can ignore that.
const MAX_TITLE_CHARS = 80;

// Cap on the raw streamed output we accumulate before sanitizing. A
// non-compliant endpoint can ignore `maxTokens` and stream unboundedly;
// `sanitize()` runs regexes (the `<think>` strip) over this string, so an
// unbounded accumulation would let it do super-linear work on the event loop.
// Generous enough for any legitimate title plus a stray `<think>` block.
const MAX_TITLE_RAW_CHARS = 4096;

// Title generation runs outside the LLM scheduler (and its watchdog), so it
// gets its own deadline: a wedged endpoint must not keep a streaming
// connection (and this fire-and-forget task) alive forever.
const TITLE_GEN_TIMEOUT_MS = 30_000;

export async function maybeGenerateTitle(sessionId: string, ownerClientId: string): Promise<void> {
  try {
    let session;
    try {
      session = sessionsRepo().getOrThrow(ownerClientId, sessionId);
    } catch {
      return;
    }
    if (session.title && session.title.trim() !== "") return;

    const sessionMessages = sessionsRepo().listMessages(sessionId);
    const firstUser = sessionMessages.find((m) => m.role === "user");
    const firstAssistant = sessionMessages.find((m) => m.role === "assistant");
    if (!firstUser || !firstAssistant) return;

    const settings = await loadCoreSettings();
    const systemPrompt = strSetting(
      settings,
      "prompts.titleGenerationPrompt",
      DEFAULT_TITLE_GENERATION_PROMPT,
    );
    const endpoint = await resolveEndpoint(settings);
    // Title-gen never benefits from reasoning; force it off so small models
    // don't burn budget on `<think>` blocks.
    endpoint.reasoning = "off";

    const llmMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: extractText(firstUser) },
      { role: "assistant", content: extractText(firstAssistant) },
      { role: "user", content: "Title:" },
    ];
    const req: LlmRequest = {
      endpoint,
      messages: llmMessages,
      overrides: { temperature: 0.3, maxTokens: 32 },
      signal: AbortSignal.timeout(TITLE_GEN_TIMEOUT_MS),
    };

    let title = "";
    for await (const delta of streamChatCompletion(req)) {
      if (delta.contentDelta) title += delta.contentDelta;
      // Stop accumulating once we have far more than any real title needs;
      // breaking the loop also returns the async generator so the upstream
      // stream is torn down.
      if (title.length > MAX_TITLE_RAW_CHARS) break;
    }
    title = sanitize(title);
    if (!title) return;

    sessionsRepo().patchTitle(ownerClientId, sessionId, title);
    wsHub().broadcastToClient(ownerClientId, {
      kind: "session.updated",
      sessionId,
      op: "title_changed",
      payload: { title },
    });
  } catch (err) {
    log.warn(`title gen failed for ${sessionId}: ${errMessage(err)}`);
  }
}

// Exported for testing. `sanitize` is purely lexical: strips
// `<think>`/`Title:`/quotes/punctuation, collapses whitespace, caps length.
export function __sanitizeForTesting(raw: string): string {
  return sanitize(raw);
}

function sanitize(raw: string): string {
  let s = raw;
  // Strip any <think>...</think> blocks the model may have emitted (some
  // reasoning models can't be cleanly told to skip them).
  s = s.replace(/<think[\s\S]*?<\/think>/gi, "");
  // Title-only output: drop everything after the first line.
  s = s.split("\n")[0] ?? "";
  s = s.trim();
  // Strip an optional "Title:" prefix the model often re-emits.
  s = s.replace(/^title\s*[:-]\s*/i, "");
  // Strip surrounding quotes and trailing punctuation the model often adds
  // despite the instruction.
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  s = s.replace(/[.!?]+$/g, "").trim();
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ");
  if (s.length > MAX_TITLE_CHARS) s = s.slice(0, MAX_TITLE_CHARS).trimEnd();
  return s;
}

function extractText(m: { content?: unknown }): string {
  // Domain messages may use either a string content or an array of parts.
  // For title prompting we just need a representative text snippet.
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function strSetting(s: Record<string, unknown>, key: string, def: string): string {
  const v = s[key];
  return typeof v === "string" && v.length > 0 ? v : def;
}
