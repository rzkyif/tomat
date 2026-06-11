// LLM provider abstraction.
//
// All chat traffic flows client -> core -> upstream (per plan §9). This
// module owns the upstream call: it builds an OpenAI-SDK-compatible client
// pointed at either the local llama-server or an external endpoint, runs
// a streaming chat completion, and yields raw OpenAI delta chunks.
//
// The scheduler (llm-scheduler.ts) wraps the call to enforce concurrency.
// services/chat.ts wraps the scheduler to orchestrate the turn lifecycle
// (tool-call hops, persistence, frame emission).

import OpenAI from "openai";

// The SDK's exposed fetch contract. Re-declared here (rather than
// imported from the SDK's `./internal/...`) so we don't depend on
// internal paths. Kept synchronized with @openai/Fetch.
type SdkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type LlmRoute = "default" | "secondary";

export interface LlmEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  // Optional reasoning hint (provider-specific encoding handled below).
  reasoning?: "off" | "on" | "auto";
  // OpenAI-style sampling overrides.
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  // Test seam: when present, the OpenAI SDK uses this fetch instead of the
  // global. Production callers leave this undefined. Typed to the SDK's
  // `Fetch` shape (single-signature `(input, init?) => Promise<Response>`)
  // rather than `typeof fetch` so the overload-vs-single-signature
  // mismatch doesn't force a cast at the construction site.
  fetch?: SdkFetch;
}

export interface LlmRequest {
  endpoint: LlmEndpointConfig;
  // OpenAI-SDK chat-completion message shape (caller has already converted
  // domain messages into this format).
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  // Optional tool list (OpenAI function-tool format).
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  // Per-call sampling overrides; merged on top of endpoint defaults.
  overrides?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
  signal?: AbortSignal;
}

export interface LlmDelta {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }>;
  finishReason?: string;
  usage?: { prompt: number; completion: number; total: number };
}

// Builds an OpenAI-SDK client pointed at the configured endpoint.
export function buildClient(endpoint: LlmEndpointConfig): OpenAI {
  return new OpenAI({
    baseURL: endpoint.baseUrl,
    apiKey: endpoint.apiKey || "sk-local",
    // Keep the SDK's default timeout (10 minutes). It only bounds the time to
    // response headers, not the streamed body, so long completions are fine.
    // Never pass `timeout: 0`: the SDK treats it as a literal 0ms deadline and
    // aborts every request instantly with "Request timed out".
    maxRetries: 0,
    // The SDK's `Fetch` type ultimately resolves through DOM's RequestInit;
    // Deno's RequestInit body differs at the ReadableStream<.read(view)>
    // level (DOM allows ArrayBufferView<ArrayBufferLike>, Deno is
    // stricter). They're runtime-compatible (the SDK only constructs
    // requests via Request/string/URL, never passes a ReadableStream body)
    // but TS can't see that. The cast is the boundary marker.
    // deno-lint-ignore no-explicit-any
    ...(endpoint.fetch ? { fetch: endpoint.fetch as any } : {}),
  });
}

// Runs a streaming chat completion and yields normalized deltas.
export async function* streamChatCompletion(req: LlmRequest): AsyncIterable<LlmDelta> {
  const client = buildClient(req.endpoint);

  const temperature = req.overrides?.temperature ?? req.endpoint.temperature;
  const topP = req.overrides?.topP ?? req.endpoint.topP;
  const maxTokens = req.overrides?.maxTokens ?? req.endpoint.maxTokens;

  const extra: Record<string, unknown> = {};
  if (req.endpoint.reasoning) {
    const isLocal = isLocalEndpoint(req.endpoint.baseUrl);
    if (isLocal) {
      // llama.cpp accepts `chat_template_kwargs.enable_thinking` (per its
      // server docs). Thinking-by-default models (e.g. Qwen3) keep thinking
      // unless the template is explicitly told `false`, so "off" must send
      // the flag rather than omit it. "auto" lets the model decide whether
      // to actually produce a trace.
      extra.chat_template_kwargs = { enable_thinking: req.endpoint.reasoning !== "off" };
    } else if (req.endpoint.reasoning !== "off") {
      // OpenAI-compatible servers accept `reasoning_effort`: on→high,
      // auto→low. "off" sends nothing: non-reasoning models reject the
      // parameter.
      extra.reasoning_effort = req.endpoint.reasoning === "on" ? "high" : "low";
    }
  }

  const stream = await client.chat.completions.create(
    {
      model: req.endpoint.model,
      messages: req.messages,
      tools: req.tools,
      stream: true,
      stream_options: { include_usage: true },
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...extra,
    },
    { signal: req.signal },
  );

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta: LlmDelta = {};
    if (choice?.delta?.content) delta.contentDelta = choice.delta.content;
    // Reasoning can arrive as either `reasoning_content` (llama.cpp /
    // DeepSeek style) or a flat `reasoning` string (some OpenAI-compatible
    // gateways). Accept either, preferring `reasoning_content` when both
    // appear in the same delta.
    const rawDelta = choice?.delta as
      | { reasoning_content?: string; reasoning?: string }
      | undefined;
    const reasoning = rawDelta?.reasoning_content ?? rawDelta?.reasoning;
    if (reasoning) delta.reasoningDelta = reasoning;
    const toolCalls = choice?.delta?.tool_calls;
    if (toolCalls) {
      delta.toolCalls = toolCalls.map((tc) => ({
        index: tc.index,
        id: tc.id,
        name: tc.function?.name,
        argumentsDelta: tc.function?.arguments,
      }));
    }
    if (choice?.finish_reason) delta.finishReason = choice.finish_reason;
    if (chunk.usage) {
      delta.usage = {
        prompt: chunk.usage.prompt_tokens ?? 0,
        completion: chunk.usage.completion_tokens ?? 0,
        total: chunk.usage.total_tokens ?? 0,
      };
    }
    yield delta;
  }
}

function isLocalEndpoint(baseUrl: string): boolean {
  return (
    baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") || baseUrl.includes("0.0.0.0")
  );
}
