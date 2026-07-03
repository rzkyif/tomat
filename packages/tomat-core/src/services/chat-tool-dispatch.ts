// Re-export shim: tool-call dispatch now lives in @tomat/core-engine (extension
// sandbox + MCP client via host().tools). Core imports unchanged.
export { ToolDispatcher } from "@tomat/core-engine/services/chat-tool-dispatch";
export type { InFlightEntry } from "@tomat/core-engine/services/chat-tool-dispatch";
