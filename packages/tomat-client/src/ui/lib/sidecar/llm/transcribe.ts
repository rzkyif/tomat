/**
 * LLM-driven post-processing of audio transcriptions: cleanup of raw
 * speech-to-text output and merging a new transcription into existing
 * textarea text. The actual STT call lives in `$lib/sidecar/stt`.
 */

import { settingsState } from "$lib/state";
import { singleShotLLM } from "./client";

/** Correct transcription mistakes using the LLM. */
export async function autocorrectTranscription(text: string): Promise<string> {
  const settings = settingsState.currentSettings;
  return singleShotLLM(settings["prompts.autocorrectPrompt"], text);
}

/** Merge a new transcription into existing textarea text via single-shot LLM. */
export async function mergeTranscription(existing: string, transcription: string): Promise<string> {
  const settings = settingsState.currentSettings;
  const userMessage = `<existing>\n${existing}\n</existing>\n<new>\n${transcription}\n</new>`;
  return singleShotLLM(settings["prompts.mergeTranscriptionPrompt"], userMessage);
}
