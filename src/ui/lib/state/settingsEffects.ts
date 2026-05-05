/**
 * Side-effect orchestrator for settingsState changes. Subscribes once and
 * drives the matching state mutations on other modules (sidecar restart,
 * VAD pause, TTS toggle). Lives outside settings.svelte so settings stays a
 * passive store: each consumer below imports settingsState to read current
 * values, so settings can't import them back without creating a cycle.
 */

import { restartServerIfNeed } from "../sidecar/manager";
import { settingsState } from "./settings.svelte";
import { streamingState } from "./streaming.svelte";
import { vadManager } from "./vad.svelte";

const restartTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function debounceRestart(type: "llm" | "stt"): void {
  const existing = restartTimeouts.get(type);
  if (existing) clearTimeout(existing);
  restartTimeouts.set(
    type,
    setTimeout(async () => {
      if (type === "llm") {
        await streamingState.interruptStreaming();
      }
      restartServerIfNeed(type);
      restartTimeouts.delete(type);
    }, 500),
  );
}

settingsState.onChange((key, prev, next) => {
  if (key.startsWith("llm.")) {
    debounceRestart("llm");
  } else if (key.startsWith("stt.")) {
    debounceRestart("stt");
    // If the STT enable toggle just flipped off, also stop VAD; otherwise
    // the in-browser VAD instance keeps listening and tries to transcribe
    // against a whisper-server we just shut down. Use forceDisable rather
    // than detach so the visibility listener and speech handler stay wired
    // up for a later re-enable.
    if (key === "stt.enabled" && prev !== false && !next) {
      void vadManager.forceDisable();
    }
  } else if (key === "tts.enabled" && !!prev !== !!next) {
    // tts.svelte is intentionally lazy (see state/index.ts) - keep this
    // import dynamic so the tts bundle doesn't get pulled into the eager
    // graph through this orchestrator.
    void import("./tts.svelte").then(({ ttsState }) => ttsState.setEnabled(!!next));
  }
});
