// Re-export shim: the tool-relevance filter now lives in @tomat/core-engine (it
// reads the tool catalog + embeddings through host().tools). Core imports
// unchanged.
export { __resetForTesting, ToolFilter, toolFilter } from "@tomat/core-engine/services/tool-filter";
export type { Phase1Options, Phase1Result } from "@tomat/core-engine/services/tool-filter";
