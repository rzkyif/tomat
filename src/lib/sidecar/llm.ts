import OpenAI from "openai";
import { titleCase } from "title-case";
import { settingsState, messagesState } from "../state";
import { setInterruptController } from "$lib/shared/interrupt";
import { buildSystemPrompt } from "$lib/shared/systemPrompt";
import { readSessionAttachment, base64ToUtf8 } from "$lib/shared/attachments";
import type { LLMErrorType, MessageContent } from "$lib/shared/types";

// --- Error mapping ---

export interface LLMError {
  type: LLMErrorType;
  detail?: string;
}

/** Map OpenAI/llama API errors to our error types */
export function mapError(err: any): LLMError {
  const errorType = err?.type || err?.error?.type || "";
  const errorCode = err?.code || err?.status || err?.error?.code || "";
  const errorMessage = err?.message || err?.error?.message || "";

  let type: LLMErrorType;

  if (
    errorType.includes("context_size") ||
    errorCode === 413 ||
    errorCode === "context_length_exceeded" ||
    errorMessage.toLowerCase().includes("context length")
  ) {
    type = "context_length_exceeded_error";
  } else if (errorType.includes("rate_limit") || errorCode === 429) {
    type = "rate_limit_error";
  } else if (errorType.includes("authentication") || errorCode === 401) {
    type = "authentication_error";
  } else if (errorType.includes("invalid_request") || errorCode === 400 || errorCode === 422) {
    type = "invalid_request_error";
  } else if ((errorCode >= 500 && errorCode < 600) || errorType.includes("server_error")) {
    type = "server_error";
  } else {
    type = "unknown_error";
  }

  return { type, detail: errorMessage || undefined };
}

// --- Client creation ---

/** Create an OpenAI-compatible client */
export function createOpenAIClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL, apiKey, dangerouslyAllowBrowser: true });
}

/** Create an OpenAI client pointing at the configured LLM server */
export function getLLMClient(): OpenAI {
  const settings = settingsState.currentSettings;
  const preset = settings["llm.preset"];

  if (preset === "external") {
    return createOpenAIClient(settings["llm.external.baseUrl"], settings["llm.external.apiKey"]);
  } else {
    const host = settings["llm.host"] || "127.0.0.1";
    const port = settings["llm.port"] || "7701";
    return createOpenAIClient(`http://${host}:${port}/v1`, "local");
  }
}

/** Create an OpenAI client for the configured Dual-Model secondary endpoint. */
export function getSecondaryLLMClient(): OpenAI {
  const settings = settingsState.currentSettings;
  return createOpenAIClient(
    settings["dualModel.external.baseUrl"],
    settings["dualModel.external.apiKey"],
  );
}

// --- Context size ---

/** Get the configured context size for the current LLM */
export function getContextSize(): number {
  const settings = settingsState.currentSettings;
  if (settings["llm.preset"] === "external") {
    return settings["llm.external.contextSize"] || 128000;
  }
  return settings["llm.contextSize"] || 4096;
}

/**
 * When dual-model routing is enabled, ask the default model whether the last
 * user message warrants the stronger external model.
 */
export async function routeSelection(): Promise<"default" | "secondary"> {
  const settings = settingsState.currentSettings;
  if (!settings["dualModel.enabled"]) return "default";

  const hasSecondaryConfig =
    typeof settings["dualModel.external.baseUrl"] === "string" &&
    settings["dualModel.external.baseUrl"].length > 0 &&
    typeof settings["dualModel.external.model"] === "string" &&
    settings["dualModel.external.model"].length > 0;
  if (!hasSecondaryConfig) return "default";

  // `messagesState.messages` is stored newest-first (see addMessage's
  // `unshift`), so `.find(...)` without reversing returns the MOST RECENT
  // user message - which is what we want to classify. Reversing would match
  // the first user message in the session, so follow-ups would be routed
  // based on the very first question every time.
  const lastUser = messagesState.messages.find((m) => m.role === "user");
  if (!lastUser) return "default";

  const detectionPrompt =
    settings["dualModel.detectionPrompt"] ||
    "Classify the user's request as `simple` or `complex`. Reply with exactly one word.";

  try {
    const verdict = await singleShotLLM(detectionPrompt, lastUser.content);
    const norm = verdict.trim().toLowerCase();
    // Lenient match: small local models rarely comply perfectly with
    // "reply with one word". Accept any mention of "complex" that isn't
    // dominated by "simple".
    const hasComplex = /\bcomplex(?:ity|ness)?\b/.test(norm);
    const hasSimple = /\bsimple(?:st)?\b/.test(norm);
    const route: "default" | "secondary" = hasComplex && !hasSimple ? "secondary" : "default";
    console.log(`[llm] dual-model detection verdict=${JSON.stringify(verdict)} -> ${route}`);
    return route;
  } catch (e) {
    console.warn("[llm] dual-model routing failed; falling back to default:", e);
    return "default";
  }
}

// --- Utility LLM calls ---

/** Single-shot non-streaming LLM call for utilities (title gen, autocorrect, routing) */
export async function singleShotLLM(
  systemPrompt: string,
  userMessage: MessageContent,
): Promise<string> {
  const client = getLLMClient();
  const settings = settingsState.currentSettings;
  const preset = settings["llm.preset"];
  const model = preset === "external" ? settings["llm.external.model"] : "default";

  const apiContent = await contentToApi(userMessage);
  const request: OpenAI.ChatCompletionCreateParamsNonStreaming & {
    reasoning?: { effort: string; budget: number };
  } = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: apiContent as OpenAI.ChatCompletionUserMessageParam["content"] },
    ],
    stream: false as const,
  };

  // Disable reasoning for local models to get faster utility responses
  if (preset !== "external") {
    request.reasoning = { effort: "low", budget: 0 };
  }

  const response = await client.chat.completions.create(request);

  return response.choices?.[0]?.message?.content?.trim() || "";
}

/** Generate a short session title from the first user message */
export async function generateSessionTitle(firstMessage: string): Promise<string> {
  const raw = await singleShotLLM(
    `You are a title generator. Your ONLY job is to create a short title (3 to 5 words) that describes what the user's message is about.

Rules:
- Output ONLY the title, nothing else.
- Do NOT answer the user's question.
- Do NOT add quotes or punctuation at the end.
- The title must be 3 to 5 words long.

Examples:

User: How do I center a div in CSS?
Title: Centering A Div

User: Can you help me write a Python script to rename files?
Title: Python File Renaming Script

User: I'm having trouble with my React app crashing on startup
Title: React App Crash Issue

User: What's the best way to learn guitar?
Title: Learning Guitar Tips`,
    firstMessage,
  );
  // Postprocess: ensure title case and strip trailing punctuation
  return titleCase(raw.replace(/[.!?]+$/, ""));
}

/** Correct transcription mistakes using the LLM */
export async function autocorrectTranscription(text: string): Promise<string> {
  return singleShotLLM(
    `You are a transcription corrector. Your ONLY job is to fix small mistakes in speech-to-text output. Do NOT change the meaning. Do NOT add or remove sentences. Do NOT answer or respond to the text. Output ONLY the corrected text, nothing else.

Common mistakes to fix:
- Wrong homophones (e.g. "there" vs "their", "your" vs "you're")
- Missing or extra small words (e.g. "a", "the", "is")
- Misheard technical terms or names
- Missing punctuation or capitalization

Examples:

Input: i want too create a new react component for the side bar
Output: I want to create a new React component for the sidebar.

Input: can you fix the bug were the button doesnt work when i click on it
Output: Can you fix the bug where the button doesn't work when I click on it?

Input: their is a error in the console that says type error
Output: There is an error in the console that says TypeError.`,
    text,
  );
}

// --- Message sending ---

type ApiMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ApiMessage = {
  role: "user" | "assistant" | "system";
  content: string | ApiMessagePart[];
};

/** Convert our MessageContent to the OpenAI API format. Materializes any
 *  on-disk attachment parts by reading them from the session directory. */
async function contentToApi(content: MessageContent): Promise<string | ApiMessagePart[]> {
  if (typeof content === "string") return content;

  const parts: ApiMessagePart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
    } else if (part.type === "document") {
      parts.push({
        type: "text",
        text: `[Attached document: ${part.filename}]\n\n${part.markdown}`,
      });
    } else if (part.type === "image_file") {
      try {
        const b64 = await readSessionAttachment(part.path);
        parts.push({
          type: "image_url",
          image_url: { url: `data:${part.mime};base64,${b64}` },
        });
      } catch (e) {
        console.warn("[llm] failed to load image attachment:", part.path, e);
      }
    } else if (part.type === "document_file") {
      try {
        const b64 = await readSessionAttachment(part.path);
        const markdown = base64ToUtf8(b64);
        parts.push({
          type: "text",
          text: `[Attached document: ${part.filename}]\n\n${markdown}`,
        });
      } catch (e) {
        console.warn("[llm] failed to load document attachment:", part.path, e);
      }
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

export async function sendMessages(): Promise<void> {
  const controller = new AbortController();
  setInterruptController(controller);

  const route = await routeSelection();
  messagesState.startStreaming(route);

  try {
    const settings = settingsState.currentSettings;
    const preset = settings["llm.preset"];
    const usingSecondary = route === "secondary";
    const client = usingSecondary ? getSecondaryLLMClient() : getLLMClient();

    const chatMessages = messagesState.messages
      .slice()
      .reverse()
      .filter(
        (m): m is typeof m & { role: "user" | "assistant" } =>
          m.role === "user" || m.role === "assistant",
      );
    const apiMessages: ApiMessage[] = await Promise.all(
      chatMessages.map(async (m) => ({
        role: m.role,
        content: await contentToApi(m.content),
      })),
    );

    // exclude the last incomplete assistant placeholder
    apiMessages.pop();

    const isFirstUserMessage = apiMessages.length === 1 && apiMessages[0].role === "user";
    const firstUserContent = isFirstUserMessage ? apiMessages[0].content : null;

    const systemPrompt = buildSystemPrompt();
    if (systemPrompt) {
      apiMessages.unshift({ role: "system", content: systemPrompt });
    }

    const useReasoning =
      !usingSecondary && preset !== "external" && settings["llm.reasoning"] === "on";
    const reasoningBudget = settings["llm.reasoningBudget"];
    const model = usingSecondary
      ? settings["dualModel.external.model"]
      : preset === "external"
        ? settings["llm.external.model"]
        : "default";

    const request: OpenAI.ChatCompletionCreateParamsStreaming & {
      reasoning?: { effort: string; budget: number };
    } = {
      model,
      messages: apiMessages as OpenAI.ChatCompletionMessageParam[],
      stream: true,
      stream_options: { include_usage: true },
    };

    if (useReasoning && reasoningBudget) {
      request.reasoning = {
        effort: "high",
        budget: Number(reasoningBudget),
      };
    }

    // Fire-and-forget title generation on first message
    // Only if the session title is still empty/default (don't overwrite user edits)
    // Skip entirely when sessions are not being stored.
    const currentTitle = messagesState.sessionTitle;
    const defaultTitle = messagesState.getDefaultTitle();
    const shouldGenerateTitle =
      isFirstUserMessage &&
      firstUserContent !== null &&
      settings["general.session.storeSessions"] !== false &&
      (!currentTitle || currentTitle === defaultTitle);

    if (shouldGenerateTitle) {
      const textForTitle =
        typeof firstUserContent === "string"
          ? firstUserContent
          : firstUserContent!
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join(" ");

      generateSessionTitle(textForTitle)
        .then((title) => {
          if (title) {
            messagesState.updateTitle(title);
          }
        })
        .catch((e) => console.warn("[llm] Title generation failed:", e));
    }

    const completionStream = await client.chat.completions.create(request, {
      signal: controller.signal,
    });

    for await (const chunk of completionStream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        messagesState.appendToStreaming(delta);
      }

      // Capture usage from the final chunk
      if (chunk.usage) {
        messagesState.updateTokenUsage({
          promptTokens: chunk.usage.prompt_tokens || 0,
          completionTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        });
      }
    }
    messagesState.finishStreaming();
  } catch (err: any) {
    if (controller.signal.aborted) {
      return;
    }
    console.error(`[llm] Stream error:`, err);
    const mapped = mapError(err);
    messagesState.receiveErrorMessage(mapped.type, mapped.detail);
  } finally {
    setInterruptController(null);
  }
}
