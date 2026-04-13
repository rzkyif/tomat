const BASE_URL = "http://127.0.0.1:7703";

export async function loadTtsModel(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/tts/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`TTS load failed: ${res.status} ${await res.text()}`);
  }
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
