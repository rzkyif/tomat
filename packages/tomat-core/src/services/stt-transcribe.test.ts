import { assertEquals, assertRejects } from "@std/assert";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";
import { transcribeAudio } from "./stt-transcribe.ts";
import { __resetForTesting as resetCoreSettings } from "./core-settings.ts";
import { AppError } from "../shared/errors.ts";

async function writeSettings(s: Record<string, unknown>): Promise<void> {
  await Deno.writeTextFile(paths().settingsFile, JSON.stringify(s));
  resetCoreSettings();
}

function wavFile(): File {
  // 44-byte WAV header + a little silence; the external mock ignores it.
  return new File([new Uint8Array(64)], "audio.wav", { type: "audio/wav" });
}

Deno.test("transcribeAudio: external provider posts to the OpenAI transcriptions endpoint", async () => {
  const env = await setupTestEnv();
  const realFetch = globalThis.fetch;
  try {
    await writeSettings({
      "stt.provider": "external",
      "stt.external.baseUrl": "https://api.example.com/v1",
      "stt.external.model": "whisper-1",
    });
    let calledUrl = "";
    globalThis.fetch = ((input: string | URL | Request) => {
      calledUrl = typeof input === "string" ? input : input.toString();
      return Promise.resolve(
        new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const text = await transcribeAudio(
      {
        "stt.provider": "external",
        "stt.external.baseUrl": "https://api.example.com/v1",
        "stt.external.model": "whisper-1",
      },
      wavFile(),
      undefined,
    );
    assertEquals(text, "hello world");
    assertEquals(calledUrl.includes("/audio/transcriptions"), true);
  } finally {
    globalThis.fetch = realFetch;
    await env.teardown();
  }
});

Deno.test("transcribeAudio: external provider without baseUrl/model is a validation error", async () => {
  const env = await setupTestEnv();
  try {
    const err = await assertRejects(
      () => transcribeAudio({ "stt.provider": "external" }, wavFile(), undefined),
      AppError,
    );
    assertEquals(err.code, "validation_error");
  } finally {
    await env.teardown();
  }
});
