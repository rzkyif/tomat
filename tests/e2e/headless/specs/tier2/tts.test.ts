// Tier 2: text-to-speech via the external provider added to core. With TTS
// pointed at the external mock (OpenAI /v1/audio/speech), the real client TtsApi
// round-trips text to WAV bytes through core.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { cores } from "@client/lib/core/cores.ts";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("synthesizes speech through the external TTS provider", async () => {
  app = await launchApp({
    scenario: "paired",
    settings: {
      "tts.enabled": true,
      "tts.provider": "external",
      // baseUrl/model are seeded by the harness default to the mock /v1; only the
      // provider switch is needed here. Set them explicitly for clarity.
      "tts.external.model": "tts-1",
      "tts.external.voice": "alloy",
    },
  });
  await app.chat.waitReady();

  const blob = await cores().api().tts.synthesize({ text: "hello world" });
  // The external mock returns a valid WAV (44-byte header + samples).
  expect(blob.size).toBeGreaterThan(44);
  const header = new TextDecoder().decode(await blob.slice(0, 4).arrayBuffer());
  expect(header).toBe("RIFF");
});
