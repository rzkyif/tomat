import { assertEquals, assertRejects } from "@std/assert";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { paths } from "../paths.ts";
import { synthesizeSpeech } from "./tts-synthesize.ts";
import { __resetForTesting as resetCoreSettings } from "./core-settings.ts";
import { AppError } from "../shared/errors.ts";

async function writeSettings(s: Record<string, unknown>): Promise<void> {
  await Deno.writeTextFile(paths().settingsFile, JSON.stringify(s));
  resetCoreSettings();
}

Deno.test("synthesizeSpeech: external provider posts to the OpenAI speech endpoint", async () => {
  const env = await setupTestEnv();
  const realFetch = globalThis.fetch;
  try {
    await writeSettings({
      "tts.provider": "external",
      "tts.external.baseUrl": "https://api.example.com/v1",
      "tts.external.model": "tts-1",
      "tts.external.voice": "alloy",
    });

    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]); // "RIFF"...
    let calledUrl = "";
    globalThis.fetch = ((input: string | URL | Request, _init?: RequestInit) => {
      calledUrl = typeof input === "string" ? input : input.toString();
      return Promise.resolve(new Response(wav, { status: 200 }));
    }) as typeof fetch;

    const out = await synthesizeSpeech("hello world", undefined, undefined, "test-client");
    assertEquals(out, wav);
    assertEquals(calledUrl.includes("/audio/speech"), true);
  } finally {
    globalThis.fetch = realFetch;
    await env.teardown();
  }
});

Deno.test("synthesizeSpeech: external provider without baseUrl/model is a validation error", async () => {
  const env = await setupTestEnv();
  try {
    await writeSettings({ "tts.provider": "external" });
    const err = await assertRejects(() => synthesizeSpeech("hi"), AppError);
    assertEquals(err.code, "validation_error");
  } finally {
    await env.teardown();
  }
});

Deno.test("synthesizeSpeech: external provider surfaces upstream failures as provider_error", async () => {
  const env = await setupTestEnv();
  const realFetch = globalThis.fetch;
  try {
    await writeSettings({
      "tts.provider": "external",
      "tts.external.baseUrl": "https://api.example.com/v1",
      "tts.external.model": "tts-1",
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response("upstream boom", { status: 500 }))) as typeof fetch;
    const err = await assertRejects(() => synthesizeSpeech("hi"), AppError);
    assertEquals(err.code, "provider_error");
  } finally {
    globalThis.fetch = realFetch;
    await env.teardown();
  }
});
