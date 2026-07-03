// Re-export shim: tool selection (LLM-exposure gate + relevance pipeline) now
// lives in @tomat/core-engine (tool catalog via host().tools). Core imports
// unchanged.
export {
  buildToolList,
  enabledToolsByName,
  listEnabledTools,
  toolExposable,
} from "@tomat/core-engine/services/chat-tool-selection";
export type { ToolSelection } from "@tomat/core-engine/services/chat-tool-selection";
