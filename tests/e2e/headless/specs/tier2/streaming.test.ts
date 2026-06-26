// Tier 2: streaming behaviours that only emerge from a live LLM stream over the
// wire - interrupting a turn mid-flight, and a reasoning turn. Both ride the
// richer mock LLM (slowText / reasoning scripts).
import { afterEach, expect, test, vi } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { messagesState } from "@client/state/messages.svelte";
import { streamingState } from "@client/state/streaming.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

function assistant(): { content?: string; interrupted?: boolean } | undefined {
  return messagesState.messages.find((m) => m.role === "assistant");
}

test("interrupting a long stream keeps the partial reply, marked interrupted", async () => {
  app = await launchApp({
    scenario: "paired",
    llm: {
      kind: "slowText",
      text: "one two three four five six seven eight nine ten",
      perChunkMs: 500,
    },
  });
  await app.chat.waitReady();
  await app.chat.send("stream slowly please");

  // Wait until the assistant turn is live and the first words have arrived.
  await vi.waitFor(() => expect((assistant()?.content ?? "").length).toBeGreaterThan(0), {
    timeout: 10_000,
    interval: 100,
  });

  // Interrupt mid-stream (the call the stop button makes).
  await streamingState.interruptStreaming();

  // The partial settles, flagged interrupted, and never reached the final word.
  await vi.waitFor(() => expect(assistant()?.interrupted).toBe(true), {
    timeout: 15_000,
    interval: 200,
  });
  const a = assistant()!;
  expect((a.content ?? "").length).toBeGreaterThan(0);
  expect(a.content ?? "").not.toContain("ten");
}, 60_000);

test("a reasoning turn renders the reasoning and the final answer", async () => {
  app = await launchApp({
    scenario: "paired",
    llm: { kind: "reasoning", reasoning: "let me think about colours", text: "the answer is teal" },
  });
  await app.chat.waitReady();
  await app.chat.send("what colour?");
  await app.chat.expectText("the answer is teal");

  const reasoning = messagesState.messages.find((m) => m.role === "reasoning") as
    | { content?: string }
    | undefined;
  expect(reasoning, "a reasoning message was produced").toBeTruthy();
  expect(reasoning!.content ?? "").toContain("let me think about colours");
}, 60_000);
