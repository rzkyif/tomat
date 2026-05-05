/**
 * Re-exports for every reactive state module in this folder so other code
 * can import any state from a single path.
 */

export * from "./servers.svelte";
export * from "./settings.svelte";
export * from "./sessions.svelte";
export * from "./persistence.svelte";
export * from "./streaming.svelte";
export * from "./messages.svelte";
export * from "./confirm.svelte";
export * from "./colorPicker.svelte";
export * from "./snippets.svelte";
export * from "./toolkits.svelte";
export * from "./expansion.svelte";
export * from "./downloads.svelte";
// tts.svelte is intentionally not re-exported here: it is heavy (audio + TTS
// model plumbing) and every +page.svelte consumer of `$lib/state` would
// otherwise drag it into the eager first-paint graph. Import it directly
// from "$lib/state/tts.svelte" when needed.

// Side-effect import: wires settingsState.onChange listeners that drive
// sidecar restarts, VAD pauses, and TTS toggles. Must come after the modules
// it depends on are exported above so they're already initialized when the
// orchestrator's top-level subscription runs.
import "./settingsEffects";
