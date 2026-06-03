// Unit coverage for the settings -> required-files mapping (the single source
// of truth shared by core + client). Pure functions, no I/O.

import { assertEquals } from "@std/assert";
import { TRIPLES } from "./model.ts";
import { binaryUnavailableOnTriple, requiredBinaryKinds } from "./model.ts";
import { requiredModelRefs } from "./settings/engine.ts";

Deno.test("requiredModelRefs: llm local with image support yields model + mmproj", () => {
  const refs = requiredModelRefs({
    "llm.provider": "local",
    "llm.modelPath": "@u/r/main/m.gguf",
    "llm.supportImages": true,
    "llm.mmprojPath": "@u/r/main/mm.gguf",
  });
  assertEquals(
    refs.filter((r) => r.group === "llm").map((r) => r.source),
    ["@u/r/main/m.gguf", "@u/r/main/mm.gguf"],
  );
});

Deno.test("requiredModelRefs: external llm contributes no llm model", () => {
  const refs = requiredModelRefs({
    "llm.provider": "external",
    "llm.modelPath": "@u/r/main/m.gguf",
  });
  assertEquals(
    refs.some((r) => r.group === "llm"),
    false,
  );
});

Deno.test("requiredModelRefs: stt model only when enabled + local", () => {
  const base = { "stt.modelPath": "@u/r/main/w.bin" };
  assertEquals(
    requiredModelRefs({ ...base, "stt.enabled": false }).some((r) => r.group === "stt"),
    false,
  );
  assertEquals(
    requiredModelRefs({ ...base, "stt.enabled": true, "stt.provider": "external" }).some(
      (r) => r.group === "stt",
    ),
    false,
  );
  assertEquals(
    requiredModelRefs({ ...base, "stt.enabled": true, "stt.provider": "local" }).some(
      (r) => r.group === "stt",
    ),
    true,
  );
});

Deno.test("requiredModelRefs: tts base files only when tts.enabled; embed always", () => {
  const off = requiredModelRefs({});
  assertEquals(
    off.some((r) => r.group === "tts"),
    false,
  );
  assertEquals(
    off.some((r) => r.group === "embed"),
    true,
  );

  const on = requiredModelRefs({ "tts.enabled": true });
  assertEquals(
    on.some((r) => r.group === "tts"),
    true,
  );
});

Deno.test("requiredBinaryKinds: deno always; llama/whisper gated", () => {
  assertEquals(requiredBinaryKinds({ "llm.provider": "external" }), ["deno"]);
  assertEquals(requiredBinaryKinds({ "llm.provider": "local" }).sort(), ["deno", "llama-server"]);
  assertEquals(
    requiredBinaryKinds({
      "llm.provider": "local",
      "stt.enabled": true,
      "stt.provider": "local",
    }).sort(),
    ["deno", "llama-server", "whisper-server"],
  );
});

Deno.test("binaryUnavailableOnTriple: every sidecar binary is available on all triples", () => {
  for (const triple of TRIPLES) {
    assertEquals(binaryUnavailableOnTriple("llama-server", triple), false);
    assertEquals(binaryUnavailableOnTriple("whisper-server", triple), false);
    assertEquals(binaryUnavailableOnTriple("deno", triple), false);
  }
});
