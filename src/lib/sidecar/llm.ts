import OpenAI from "openai";
import { titleCase } from "title-case";
import { settingsState, messagesState } from "../state";
import { setInterruptController } from "$lib/shared/interrupt";
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

// --- Context size ---

/** Get the configured context size for the current LLM */
export function getContextSize(): number {
  const settings = settingsState.currentSettings;
  if (settings["llm.preset"] === "external") {
    return settings["llm.external.contextSize"] || 128000;
  }
  return settings["llm.contextSize"] || 4096;
}

// --- Utility LLM calls ---

/** Single-shot non-streaming LLM call for utilities (title gen, autocorrect) */
export async function singleShotLLM(systemPrompt: string, userMessage: string): Promise<string> {
  const client = getLLMClient();
  const settings = settingsState.currentSettings;
  const preset = settings["llm.preset"];
  const model = preset === "external" ? settings["llm.external.model"] : "default";

  const request: OpenAI.ChatCompletionCreateParamsNonStreaming & {
    reasoning?: { effort: string; budget: number };
  } = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
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

/** Convert our MessageContent to the OpenAI API format */
function contentToApi(content: MessageContent): string | ApiMessagePart[] {
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
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

export async function sendMessages(): Promise<void> {
  messagesState.startStreaming();

  const controller = new AbortController();
  setInterruptController(controller);

  try {
    const client = getLLMClient();
    const settings = settingsState.currentSettings;
    const preset = settings["llm.preset"];

    const apiMessages: ApiMessage[] = messagesState.messages
      .slice()
      .reverse()
      .filter(
        (m): m is typeof m & { role: "user" | "assistant" } =>
          m.role === "user" || m.role === "assistant",
      )
      .map((m) => ({ role: m.role, content: contentToApi(m.content) }));

    // exclude the last incomplete assistant placeholder
    apiMessages.pop();

    const isFirstUserMessage = apiMessages.length === 1 && apiMessages[0].role === "user";

    const useReasoning = preset !== "external" && settings["llm.reasoning"] === "on";
    const reasoningBudget = settings["llm.reasoningBudget"];
    const model = preset === "external" ? settings["llm.external.model"] : "default";

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
    const currentTitle = messagesState.sessionTitle;
    const defaultTitle = messagesState.getDefaultTitle();
    const shouldGenerateTitle =
      isFirstUserMessage && (!currentTitle || currentTitle === defaultTitle);

    if (shouldGenerateTitle) {
      const firstContent = apiMessages[0].content;
      const textForTitle =
        typeof firstContent === "string"
          ? firstContent
          : firstContent
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
