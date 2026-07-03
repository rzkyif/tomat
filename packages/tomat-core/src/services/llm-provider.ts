// Re-export shim: the LLM provider client + streaming now live in
// @tomat/core-engine (openai SDK, runtime-agnostic). Core imports unchanged.
export { buildClient, streamChatCompletion } from "@tomat/core-engine/services/llm-provider";
export type {
  LlmDelta,
  LlmEndpointConfig,
  LlmRequest,
  LlmRoute,
} from "@tomat/core-engine/services/llm-provider";
