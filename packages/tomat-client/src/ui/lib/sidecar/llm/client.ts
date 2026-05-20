/**
 * LLM provider abstraction. Today we have two transport surfaces (the local
 * llama-server sidecar and any OpenAI-compatible external endpoint), each
 * with slightly different per-request shapes (model name, reasoning
 * parameter style, context size). Behind `LLMProvider`, those differences
 * collapse into a one-liner lookup: callers ask `getProvider("primary")` (or
 * `"secondary"`) and use the returned instance.
 */

import OpenAI from "openai";
import { settingsState } from "$lib/state";
import type { MessageContent } from "$lib/shared/types";
import { contentToApi } from "./wire";

export type ReasoningMode = "off" | "on" | "auto";

export interface SingleShotOptions {
  reasoning?: { mode: ReasoningMode; budget?: number };
}

/** Per-request mutable shape that providers stamp their reasoning toggles
 *  onto. Mirrors the OpenAI SDK request type plus the llama-server
 *  `chat_template_kwargs` extension and the OpenAI-style `reasoning_effort`
 *  string. */
export type ReasoningCarrier = {
  chat_template_kwargs?: Record<string, unknown>;
  reasoning_effort?: string;
  reasoning?: { effort: string; budget: number };
};

export interface LLMProvider {
  /** Build a fresh OpenAI client pointed at this provider's endpoint. */
  createClient(): OpenAI;
  /** Total tokens this provider's model can hold in context. */
  getContextSize(): number;
  /** Model name to send in the request body. For local llama-server the
   *  field is ignored by the backend (a single model is loaded), so we send
   *  a placeholder. External providers use the user-configured name. */
  getModel(): string;
  /** Stamp the reasoning-related fields onto a single-shot request. Called
   *  with an explicit mode (off/on/auto) and optional budget. The shape
   *  differs per provider: llama.cpp uses chat_template_kwargs, OpenAI uses
   *  reasoning_effort, and both accept `reasoning: { effort, budget }`. */
  applyReasoning(req: ReasoningCarrier, mode: ReasoningMode, budget?: number): void;
  /** Stamp the reasoning-related fields onto a streaming chat request based
   *  on the user's current settings. Encapsulates the per-provider gating
   *  (e.g. "the local llama path enables reasoning when llm.reasoning=on
   *  and a budget is set"; external/secondary leave it alone). No-op when
   *  the provider doesn't support a streaming reasoning toggle today. */
  applyStreamReasoning(req: ReasoningCarrier): void;
}

/** Construct an OpenAI-compatible client. Exported because the STT module
 *  also points at an external OpenAI-compatible endpoint (`stt.external.*`)
 *  and reuses the same client constructor. */
export function createOpenAIClient(baseURL: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL, apiKey, dangerouslyAllowBrowser: true });
}

class LocalLlamaProvider implements LLMProvider {
  createClient(): OpenAI {
    const settings = settingsState.currentSettings;
    const host = settings["llm.host"] || "127.0.0.1";
    const port = settings["llm.port"] || "7701";
    return createOpenAIClient(`http://${host}:${port}/v1`, "local");
  }

  getContextSize(): number {
    return settingsState.currentSettings["llm.contextSize"] || 4096;
  }

  getModel(): string {
    return "default";
  }

  applyReasoning(req: ReasoningCarrier, mode: ReasoningMode, budget?: number): void {
    // llama.cpp's documented per-request toggle is chat_template_kwargs.enable_thinking
    // (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
    if (mode === "off") {
      req.chat_template_kwargs = { enable_thinking: false };
      return;
    }
    req.chat_template_kwargs = { enable_thinking: true };
    const effort = mode === "on" ? "high" : "low";
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
      req.reasoning = { effort, budget };
    }
  }

  applyStreamReasoning(req: ReasoningCarrier): void {
    // The local path enables reasoning only when the user has explicitly
    // turned it on AND set a positive budget. Anything else: leave the
    // request alone so the backend uses its model-default thinking mode.
    const settings = settingsState.currentSettings;
    if (settings["llm.reasoning"] !== "on") return;
    const budget = Number(settings["llm.reasoningBudget"]);
    if (!Number.isFinite(budget) || budget <= 0) return;
    req.reasoning = { effort: "high", budget };
  }
}

class OpenAIExternalProvider implements LLMProvider {
  createClient(): OpenAI {
    const settings = settingsState.currentSettings;
    return createOpenAIClient(settings["llm.external.baseUrl"], settings["llm.external.apiKey"]);
  }

  getContextSize(): number {
    return settingsState.currentSettings["llm.external.contextSize"] || 128000;
  }

  getModel(): string {
    return settingsState.currentSettings["llm.external.model"];
  }

  applyReasoning(req: ReasoningCarrier, mode: ReasoningMode, budget?: number): void {
    // For OpenAI-compatible external servers, reasoning_effort is the
    // standard signal; servers that don't support it ignore unknown fields.
    if (mode === "off") {
      req.reasoning_effort = "minimal";
      return;
    }
    const effort = mode === "on" ? "high" : "low";
    req.reasoning_effort = effort;
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
      req.reasoning = { effort, budget };
    }
  }

  applyStreamReasoning(_req: ReasoningCarrier): void {
    // External streaming requests don't get a reasoning toggle today: the
    // user-facing llm.reasoning setting is documented as local-only, and
    // external endpoints already pick a default effort per model.
  }
}

class SecondaryProvider implements LLMProvider {
  createClient(): OpenAI {
    const settings = settingsState.currentSettings;
    return createOpenAIClient(
      settings["dualModel.external.baseUrl"],
      settings["dualModel.external.apiKey"],
    );
  }

  getContextSize(): number {
    // Secondary provider context size isn't user-configurable today; default
    // to the same generous external default.
    return 128000;
  }

  getModel(): string {
    return settingsState.currentSettings["dualModel.external.model"];
  }

  applyReasoning(req: ReasoningCarrier, mode: ReasoningMode, budget?: number): void {
    // Secondary endpoint is OpenAI-compatible by configuration today.
    if (mode === "off") {
      req.reasoning_effort = "minimal";
      return;
    }
    const effort = mode === "on" ? "high" : "low";
    req.reasoning_effort = effort;
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
      req.reasoning = { effort, budget };
    }
  }

  applyStreamReasoning(_req: ReasoningCarrier): void {
    // Secondary endpoint sees no streaming reasoning toggle: the dual-model
    // routing already chose this path because the request is "complex"; we
    // let the secondary model use its own default effort.
  }
}

/** Resolve the provider for a turn. `"primary"` reads `llm.provider` to
 *  pick local vs. external; `"secondary"` always points at the dual-model
 *  external endpoint. */
export function getProvider(role: "primary" | "secondary" = "primary"): LLMProvider {
  if (role === "secondary") return new SecondaryProvider();
  const provider = settingsState.currentSettings["llm.provider"];
  return provider === "external" ? new OpenAIExternalProvider() : new LocalLlamaProvider();
}

/** Get the configured context size for the active primary LLM. Used by the
 *  SessionBar token-usage display and the tool-filter budget math. */
export function getContextSize(): number {
  return getProvider("primary").getContextSize();
}

/** Single-shot non-streaming LLM call for utilities (title gen, autocorrect,
 *  routing, tool filtering). By default reasoning is forced off; pass
 *  `options.reasoning` to opt-in for callers that benefit from reasoning. */
export async function singleShotLLM(
  systemPrompt: string,
  userMessage: MessageContent,
  options?: SingleShotOptions,
): Promise<string> {
  const provider = getProvider("primary");
  const client = provider.createClient();
  const apiContent = await contentToApi(userMessage);

  const request: OpenAI.ChatCompletionCreateParamsNonStreaming & ReasoningCarrier = {
    model: provider.getModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: apiContent as OpenAI.ChatCompletionUserMessageParam["content"] },
    ],
    stream: false as const,
  };

  const mode: ReasoningMode = options?.reasoning?.mode ?? "off";
  provider.applyReasoning(request, mode, options?.reasoning?.budget);

  const response = await client.chat.completions.create(request);
  return response.choices?.[0]?.message?.content?.trim() || "";
}
