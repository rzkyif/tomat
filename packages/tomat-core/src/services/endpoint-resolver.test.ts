// endpoint resolver: pure transform over a settings record. Secret
// lookups are mocked through the secrets module (we don't need to stand
// up the encrypted vault for this).

import { assertEquals } from "@std/assert";
import { resolveContextSize, resolveEndpoint } from "./endpoint-resolver.ts";

Deno.test("resolveEndpoint: defaults to local llama-server when provider is unset", async () => {
  const cfg = await resolveEndpoint({});
  assertEquals(cfg.baseUrl, "http://127.0.0.1:7701/v1");
  assertEquals(cfg.apiKey, "sk-local");
  assertEquals(cfg.model, "default");
  assertEquals(cfg.reasoning, "off");
});

Deno.test("resolveEndpoint: local provider honors llm.host and llm.port", async () => {
  const cfg = await resolveEndpoint({
    "llm.provider": "local",
    "llm.host": "192.168.1.10",
    "llm.port": "8080",
    "llm.reasoning": "auto",
  });
  assertEquals(cfg.baseUrl, "http://192.168.1.10:8080/v1");
  assertEquals(cfg.reasoning, "auto");
});

Deno.test("resolveEndpoint: external provider routes to llm.external.* fields", async () => {
  const cfg = await resolveEndpoint({
    "llm.provider": "external",
    "llm.external.baseUrl": "https://api.openai.com/v1",
    "llm.external.model": "gpt-4o-mini",
    "llm.external.apiKey": "sk-real",
    "llm.reasoning": "on",
  });
  assertEquals(cfg.baseUrl, "https://api.openai.com/v1");
  assertEquals(cfg.apiKey, "sk-real");
  assertEquals(cfg.model, "gpt-4o-mini");
  assertEquals(cfg.reasoning, "on");
});

Deno.test("resolveEndpoint: route=secondary reads dualModel.* fields", async () => {
  const cfg = await resolveEndpoint(
    {
      "dualModel.external.baseUrl": "https://api2.example.com/v1",
      "dualModel.external.model": "fast-model",
      "dualModel.external.apiKey": "sk-2",
    },
    "secondary",
  );
  assertEquals(cfg.baseUrl, "https://api2.example.com/v1");
  assertEquals(cfg.model, "fast-model");
  assertEquals(cfg.apiKey, "sk-2");
  // Secondary route never forwards reasoning.
  assertEquals(cfg.reasoning, "off");
});

Deno.test("resolveContextSize: returns local default 4096 when nothing is set", () => {
  assertEquals(resolveContextSize({}), 4096);
});

Deno.test("resolveContextSize: returns 128000 for external on default route", () => {
  assertEquals(resolveContextSize({ "llm.provider": "external" }), 128000);
});

Deno.test("resolveContextSize: secondary route reads dualModel.external.contextSize", () => {
  assertEquals(resolveContextSize({ "dualModel.external.contextSize": 64000 }, "secondary"), 64000);
});

Deno.test("resolveContextSize: coerces numeric string", () => {
  assertEquals(resolveContextSize({ "llm.contextSize": "8192" }), 8192);
});

Deno.test("resolveContextSize: ignores non-finite values and falls back to default", () => {
  assertEquals(resolveContextSize({ "llm.contextSize": "nope" }), 4096);
  assertEquals(resolveContextSize({ "llm.contextSize": Number.NaN }), 4096);
});
