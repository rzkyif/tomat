/**
 * HTTP client for the Bun sidecar's text-to-speech endpoints. Loads and
 * unloads the on-device model and asks the sidecar to synthesize chunks
 * of text into raw WAV bytes. Loading retries briefly so a fresh sidecar
 * boot doesn't surface as a user-visible error.
 */

import { BUN_SIDECAR_HTTP_BASE_URL } from "$lib/shared/network";

const BASE_URL = BUN_SIDECAR_HTTP_BASE_URL;

// The sidecar may be mid-restart (toggle-off recycles the bun process to
// release ORT memory), in which case the first few connection attempts will
// be refused. Retry briefly so a quick toggle-on right after toggle-off Just
// Works.
export async function loadTtsModel(): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/tts/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) return;
      throw new Error(`TTS load failed: ${res.status} ${await res.text()}`);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("TTS load timed out");
}

export async function unloadTtsModel(): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/tts/unload`, { method: "POST" });
  } catch (e) {
    console.warn("[tts] unload failed:", e);
  }
}

/** Synthesize one chunk. Returns raw WAV bytes. */
export async function synthesizeTts(
  text: string,
  voice: string,
  speed: number,
): Promise<ArrayBuffer> {
  const res = await fetch(`${BASE_URL}/api/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed }),
  });
  if (!res.ok) {
    throw new Error(`TTS synthesize failed: ${res.status} ${await res.text()}`);
  }
  return res.arrayBuffer();
}
