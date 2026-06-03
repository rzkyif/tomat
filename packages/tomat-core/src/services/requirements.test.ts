// computeRequirements classification: present vs missing across models +
// binaries. Network is stubbed (reject) so binary manifest/probe calls degrade
// gracefully and the test stays offline + deterministic; classification comes
// from on-disk presence (model files / binaries), not the network.

import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { binarySource, EMBED_BASE_FILES } from "@tomat/shared";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { patchCoreSettings } from "./core-settings.ts";
import { computeRequirements } from "./requirements.ts";
import { resolveHfPath } from "../models/manager.ts";

async function writeStub(absPath: string): Promise<void> {
  await Deno.mkdir(dirname(absPath), { recursive: true });
  await Deno.writeTextFile(absPath, "stub");
}

Deno.test("computeRequirements: classifies present models + missing binaries; gates by settings", async () => {
  const env = await setupTestEnv();
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("offline test"));
  try {
    // External LLM + STT/TTS disabled: required models = embed base files only;
    // required binaries = deno only (no llama-server, no whisper-server).
    await patchCoreSettings({
      "llm.provider": "external",
      "stt.enabled": false,
      "tts.enabled": false,
    });
    // Pre-create the embed files so probe short-circuits (present, no fetch).
    for (const f of EMBED_BASE_FILES) await writeStub(resolveHfPath(f));

    const snap = await computeRequirements();

    // Embed models present.
    const embed = snap.required.filter((r) => r.type === "model" && r.group === "embed");
    assertEquals(embed.length, EMBED_BASE_FILES.length);
    assertEquals(
      embed.every((r) => r.present),
      true,
    );

    // Binary set is settings-derived: deno required, llama/whisper not.
    const binSources = snap.required
      .filter((r) => r.type === "binary")
      .map((r) => r.source)
      .sort();
    assertEquals(binSources, [binarySource("deno")]);

    // deno is not on disk -> missing; embed present -> not missing.
    assertEquals(
      snap.missing.map((m) => m.source),
      [binarySource("deno")],
    );
  } finally {
    globalThis.fetch = origFetch;
    await env.teardown();
  }
});
