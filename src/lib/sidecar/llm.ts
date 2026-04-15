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

  const detectionPrompt = settings["prompts.dualModelDetectionPrompt"];

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
  const settings = settingsState.currentSettings;
  const raw = await singleShotLLM(settings["prompts.titleGenerationPrompt"], firstMessage);
  // Postprocess: ensure title case and strip trailing punctuation
  return titleCase(raw.replace(/[.!?]+$/, ""));
}

/** Correct transcription mistakes using the LLM */
export async function autocorrectTranscription(text: string): Promise<string> {
  const settings = settingsState.currentSettings;
  return singleShotLLM(settings["prompts.autocorrectPrompt"], text);
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

async function runStream(opts: {
  route: "default" | "secondary";
  /** Messages (chronological order) to include in the request body. */
  contextMessages: Array<{ role: "user" | "assistant"; content: MessageContent }>;
  /** User message whose systemPromptOverride should be consulted for this
   *  turn, if any. */
  lastUserMsg: { systemPromptOverride?: string } | undefined;
  /** When set, fire-and-forget title generation from this first user message. */
  firstUserContentForTitle: MessageContent | null;
  signal: AbortSignal;
}): Promise<void> {
  const settings = settingsState.currentSettings;
  const preset = settings["llm.preset"];
  const usingSecondary = opts.route === "secondary";
  const client = usingSecondary ? getSecondaryLLMClient() : getLLMClient();

  const apiMessages: ApiMessage[] = await Promise.all(
    opts.contextMessages.map(async (m) => ({
      role: m.role,
      content: await contentToApi(m.content),
    })),
  );

  // Prefer the turn-specific system prompt stashed on the most recent user
  // message by snippet expansion; fall back to the plain buildSystemPrompt
  // result when no snippet fired.
  const systemPrompt = opts.lastUserMsg?.systemPromptOverride ?? buildSystemPrompt();
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

  if (opts.firstUserContentForTitle !== null) {
    const content = opts.firstUserContentForTitle;
    const textForTitle =
      typeof content === "string"
        ? content
        : content
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
    signal: opts.signal,
  });

  for await (const chunk of completionStream) {
    const choiceDelta = chunk.choices?.[0]?.delta as
      | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice["delta"] & {
          reasoning_content?: string | null;
          reasoning?: string | null;
        })
      | undefined;

    const reasoningDelta = choiceDelta?.reasoning_content || choiceDelta?.reasoning || "";
    if (reasoningDelta) {
      messagesState.appendReasoning(reasoningDelta);
    }

    const delta = choiceDelta?.content || "";
    if (delta) {
      messagesState.appendToStreaming(delta);
    }

    if (chunk.usage) {
      messagesState.updateTokenUsage({
        promptTokens: chunk.usage.prompt_tokens || 0,
        completionTokens: chunk.usage.completion_tokens || 0,
        totalTokens: chunk.usage.total_tokens || 0,
      });
    }
  }
}

export async function sendMessages(): Promise<void> {
  const controller = new AbortController();
  setInterruptController(controller);

  const route = await routeSelection();
  messagesState.startStreaming(route);

  try {
    const settings = settingsState.currentSettings;

    const chatMessages = messagesState.messages
      .slice()
      .reverse()
      .filter(
        (m): m is typeof m & { role: "user" | "assistant" } =>
          m.role === "user" || m.role === "assistant",
      );
    const contextMessages = chatMessages.map((m) => ({ role: m.role, content: m.content }));

    // exclude the last incomplete assistant placeholder (pushed by startStreaming)
    contextMessages.pop();

    const isFirstUserMessage = contextMessages.length === 1 && contextMessages[0].role === "user";
    const lastUserMsg = messagesState.messages.find((m) => m.role === "user");

    const currentTitle = messagesState.sessionTitle;
    const defaultTitle = messagesState.getDefaultTitle();
    const shouldGenerateTitle =
      isFirstUserMessage &&
      settings["general.session.storeSessions"] !== false &&
      (!currentTitle || currentTitle === defaultTitle);

    await runStream({
      route,
      contextMessages,
      lastUserMsg,
      firstUserContentForTitle: shouldGenerateTitle ? contextMessages[0].content : null,
      signal: controller.signal,
    });
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

/** Regenerate a single assistant message in place. Only uses messages
 *  chronologically before the target as context; newer turns stay untouched. */
export async function reprocessMessage(messageId: string): Promise<void> {
  const targetIdx = messagesState.messages.findIndex((m) => m.id === messageId);
  if (targetIdx < 0) return;

  const target = messagesState.messages[targetIdx];
  // Preserve the route the user originally saw for this bubble; reprocess is a
  // "regenerate the same answer" action, not a re-route decision.
  const route: "default" | "secondary" = target.modelUsed === "secondary" ? "secondary" : "default";

  if (!messagesState.beginReprocess(messageId)) return;

  const controller = new AbortController();
  setInterruptController(controller);

  try {
    // Messages newest-first: everything at index > targetIdx is chronologically
    // older (and thus valid context for the target).
    const chatMessages = messagesState.messages
      .slice(targetIdx + 1)
      .reverse()
      .filter(
        (m): m is typeof m & { role: "user" | "assistant" } =>
          m.role === "user" || m.role === "assistant",
      );
    const contextMessages = chatMessages.map((m) => ({ role: m.role, content: m.content }));

    const lastUserMsg = messagesState.messages.slice(targetIdx + 1).find((m) => m.role === "user");

    await runStream({
      route,
      contextMessages,
      lastUserMsg,
      firstUserContentForTitle: null,
      signal: controller.signal,
    });
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
