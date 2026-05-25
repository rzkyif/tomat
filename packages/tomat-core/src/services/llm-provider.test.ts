// streamChatCompletion normalizes the OpenAI SSE wire format into our
// LlmDelta shape. Driven by recorded SSE fixtures via the injected fetch
// seam on LlmEndpointConfig — no real OpenAI calls.

import { assertEquals } from "@std/assert";
import { type LlmDelta, streamChatCompletion } from "./llm-provider.ts";
import { fakeOpenAIFetch } from "../../tests/helpers/fake-openai.ts";

async function collect(
  iter: AsyncIterable<LlmDelta>,
): Promise<LlmDelta[]> {
  const out: LlmDelta[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

Deno.test("streamChatCompletion: parses content deltas and finish + usage", async () => {
  const deltas = await collect(streamChatCompletion({
    endpoint: {
      baseUrl: "https://stub.test/v1",
      apiKey: "sk-test",
      model: "test",
      fetch: fakeOpenAIFetch("streaming-basic.sse"),
    },
    messages: [{ role: "user", content: "hi" }],
  }));

  const text = deltas.map((d) => d.contentDelta ?? "").join("");
  assertEquals(text, "Hello world");
  const finish = deltas.find((d) => d.finishReason);
  assertEquals(finish?.finishReason, "stop");
  const usage = deltas.find((d) => d.usage);
  assertEquals(usage?.usage, { prompt: 10, completion: 3, total: 13 });
});

Deno.test("streamChatCompletion: surfaces reasoning_content as reasoningDelta", async () => {
  const deltas = await collect(streamChatCompletion({
    endpoint: {
      baseUrl: "https://stub.test/v1",
      apiKey: "sk-test",
      model: "test",
      fetch: fakeOpenAIFetch("streaming-reasoning-tools.sse"),
    },
    messages: [{ role: "user", content: "calc" }],
  }));
  const reasoning = deltas.map((d) => d.reasoningDelta ?? "").join("");
  assertEquals(reasoning, "Let me think... about this.");
});

Deno.test("streamChatCompletion: assembles tool_calls index-by-index", async () => {
  const deltas = await collect(streamChatCompletion({
    endpoint: {
      baseUrl: "https://stub.test/v1",
      apiKey: "sk-test",
      model: "test",
      fetch: fakeOpenAIFetch("streaming-reasoning-tools.sse"),
    },
    messages: [{ role: "user", content: "calc" }],
  }));
  const toolCallChunks = deltas.flatMap((d) => d.toolCalls ?? []);
  // Two deltas, both for index 0; arguments stream as fragments.
  assertEquals(toolCallChunks.length, 2);
  assertEquals(toolCallChunks[0].id, "call_1");
  assertEquals(toolCallChunks[0].name, "do_thing");
  const args = toolCallChunks.map((tc) => tc.argumentsDelta ?? "").join("");
  assertEquals(args, '{"x":42}');
  const finish = deltas.find((d) => d.finishReason);
  assertEquals(finish?.finishReason, "tool_calls");
});
