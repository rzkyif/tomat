// Barrel for the shared settings schema. The schema + types + helpers all
// live in @tomat/shared so client (renderer) and core (defaults / wire
// format) read from a single source.

export * from "./types.ts";
export * from "./engine.ts";
// Re-export the group definitions so callers (server-side voice catalog,
// preset lookup, etc.) can introspect a specific group without walking
// SETTINGS_SCHEMA.
export { appearanceGroup } from "./groups/appearance.ts";
export { coresGroup } from "./groups/cores.ts";
export { dualModelGroup } from "./groups/dual-model.ts";
export { generalGroup } from "./groups/general.ts";
export { llmGroup } from "./groups/llm.ts";
export { promptsGroup } from "./groups/prompts.ts";
export { shortcutsGroup } from "./groups/shortcuts.ts";
export { snippetsGroup } from "./groups/snippets.ts";
export { sttGroup } from "./groups/stt.ts";
export { toolkitsGroup, toolsGroup } from "./groups/toolkits.ts";
export { ttsGroup } from "./groups/tts.ts";
export { usageGroup } from "./groups/usage.ts";
