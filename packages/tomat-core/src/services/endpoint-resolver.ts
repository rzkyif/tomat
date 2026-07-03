// Re-export shim: LLM endpoint resolution now lives in @tomat/core-engine (the
// local llama default port comes from host().localEndpoints). Core imports
// unchanged.
export { resolveContextSize, resolveEndpoint } from "@tomat/core-engine/services/endpoint-resolver";
export type { LlmRoute } from "@tomat/core-engine/services/endpoint-resolver";
