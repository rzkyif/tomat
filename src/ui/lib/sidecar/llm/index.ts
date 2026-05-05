/**
 * Public API of the LLM sidecar layer. The folder splits the work across
 * focused files (errors, providers, streaming pipeline, tool filtering,
 * title generation, transcription cleanup); this index keeps the existing
 * `import { ... } from "$lib/sidecar/llm"` call sites working unchanged.
 */

import { messagesState } from "$lib/state";
import { sendMessages, reprocessMessage } from "./stream";

export { mapError, type LLMError } from "./errors";
export {
  createOpenAIClient,
  getContextSize,
  getProvider,
  singleShotLLM,
  type LLMProvider,
  type ReasoningMode,
  type SingleShotOptions,
} from "./client";
export { generateSessionTitle } from "./title";
export { autocorrectTranscription, mergeTranscription } from "./transcribe";
export { sendMessages, reprocessMessage };

// Wire the LLM dispatch into messagesState. Messages can't import this module
// (stream.ts already imports messagesState), so we register the handlers from
// here at module load. UserInput.svelte imports from "$lib/sidecar/llm" so
// this index loads as part of the eager bundle.
messagesState.setLLMHandlers(sendMessages, reprocessMessage);
