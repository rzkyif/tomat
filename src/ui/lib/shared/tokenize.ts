/**
 * Token-counting utilities for sizing prompts against the active LLM's context
 * window. Used by the tool-filter pipeline to fit as many phase-1 candidates
 * into the filter LLM's prompt as possible without overflowing.
 *
 * Two backends:
 * - Local (llama.cpp server): hits the `/tokenize` endpoint for exact counts.
 *   Falls back to char/4 if the endpoint is unreachable (e.g. server still
 *   loading).
 * - External (OpenAI-compatible): no portable tokenize endpoint exists across
 *   providers, so we use a `chars/4` heuristic. This is the same rule
 *   llama.cpp's docs cite as a rough estimate. It biases conservative for
 *   English; non-English text and code may skew higher.
 */

import { settingsState } from "$lib/state";

const FALLBACK_CHARS_PER_TOKEN = 4;

let localTokenizeFailed = false;

function charBasedEstimate(text: string): number {
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

function getLocalTokenizeUrl(): string {
  const settings = settingsState.currentSettings;
  const host = settings["llm.host"] || "127.0.0.1";
  const port = settings["llm.port"] || "7701";
  return `http://${host}:${port}/tokenize`;
}

async function tokenizeLocal(text: string): Promise<number> {
  if (localTokenizeFailed) return charBasedEstimate(text);
  try {
    const res = await fetch(getLocalTokenizeUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`tokenize HTTP ${res.status}`);
    const data = (await res.json()) as { tokens?: unknown };
    if (!Array.isArray(data.tokens)) throw new Error("tokenize: missing tokens array");
    return data.tokens.length;
  } catch (e) {
    if (!localTokenizeFailed) {
      console.warn("[tokenize] local /tokenize failed, falling back to char/4:", e);
      localTokenizeFailed = true;
    }
    return charBasedEstimate(text);
  }
}

/** Reset the local-tokenize failure latch. Call when the LLM server transitions
 *  back to running so a previously-cold server gets re-probed. */
export function resetTokenizeFallback(): void {
  localTokenizeFailed = false;
}

/** Token count for a single string against the active LLM's tokenizer.
 *  Returns a conservative estimate when accuracy isn't available. */
export async function tokenize(text: string): Promise<number> {
  if (!text) return 0;
  const provider = settingsState.currentSettings["llm.provider"];
  if (provider === "external") return charBasedEstimate(text);
  return tokenizeLocal(text);
}

/** Token counts for many strings, batched. For local uses `Promise.all` over
 *  parallel `/tokenize` calls; for external is vectorized char/4 (no I/O). */
export async function tokenizeMany(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  const provider = settingsState.currentSettings["llm.provider"];
  if (provider === "external") return texts.map(charBasedEstimate);
  return Promise.all(texts.map(tokenizeLocal));
}
