// Re-export shim: STT transcription now lives in @tomat/core-engine (external via
// openai; local via host().localEndpoints). Core imports unchanged.
export { transcribeAudio } from "@tomat/core-engine/services/stt-transcribe";
