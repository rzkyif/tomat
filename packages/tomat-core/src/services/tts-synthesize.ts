// Re-export shim: TTS synthesis now lives in @tomat/core-engine (external via
// openai; local via host().localEndpoints). Core imports unchanged.
export { synthesizeSpeech } from "@tomat/core-engine/services/tts-synthesize";
