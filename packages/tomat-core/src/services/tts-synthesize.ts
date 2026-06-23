// Text-to-Speech synthesis core, shared by the /tts/synthesize route and the
// module broker's tts.speak op. TTS is local-only (the speech sidecar's Kokoro
// engine), so this routes every call through the speech scheduler for fair
// multi-client queueing behind the single engine. Kept as a thin service for
// parity with stt-transcribe.ts.

import { speechSpeak } from "../sidecars/speech.ts";
import { speechScheduler } from "./speech-scheduler.ts";

/** Synthesize `text` to WAV bytes via the local speech sidecar, queued behind
 *  the single engine. `clientId` keys the per-client fairness (defaults to
 *  "core" for internal callers like the module broker). */
export function synthesizeSpeech(
  text: string,
  voice?: string,
  speed?: number,
  clientId = "core",
): Promise<Uint8Array> {
  return speechScheduler().schedule(clientId, () => speechSpeak(text, voice, speed));
}
