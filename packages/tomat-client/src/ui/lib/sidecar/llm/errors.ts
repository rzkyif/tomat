/**
 * Maps OpenAI / llama API errors to the small enum the UI bubbles render
 * (rate limit, context length, auth, server, etc.). Pure: no I/O, no state.
 */

import type { LLMErrorType } from "$lib/shared/types";

export interface LLMError {
  type: LLMErrorType;
  detail?: string;
}

/** Map OpenAI/llama API errors to our error types */
export function mapError(err: unknown): LLMError {
  const e = err as
    | {
        type?: string;
        code?: string | number;
        status?: number;
        message?: string;
        error?: { type?: string; code?: string | number; message?: string };
      }
    | null
    | undefined;
  const errorType = e?.type || e?.error?.type || "";
  const errorCode = e?.code || e?.status || e?.error?.code || "";
  const errorMessage = e?.message || e?.error?.message || "";

  let type: LLMErrorType;

  if (
    errorType.includes("context_size") ||
    errorCode === 413 ||
    errorCode === "context_length_exceeded" ||
    errorMessage.toLowerCase().includes("context length")
  ) {
    type = "context_length_exceeded_error";
  } else if (errorType.includes("rate_limit") || errorCode === 429) {
    type = "rate_limit_error";
  } else if (errorType.includes("authentication") || errorCode === 401) {
    type = "authentication_error";
  } else if (errorType.includes("invalid_request") || errorCode === 400 || errorCode === 422) {
    type = "invalid_request_error";
  } else if (
    (typeof errorCode === "number" && errorCode >= 500 && errorCode < 600) ||
    errorType.includes("server_error")
  ) {
    type = "server_error";
  } else {
    type = "unknown_error";
  }

  return { type, detail: errorMessage || undefined };
}
