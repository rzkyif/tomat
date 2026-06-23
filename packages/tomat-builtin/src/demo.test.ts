// demo tool drives the askUser protocol. Uses a hand-rolled mock
// ToolContext (no real worker bridge). Doubles as the worked example for
// third-party extension authors looking to test their tools.

import { assertEquals } from "@std/assert";
import { demo } from "./demo.ts";
import type { AskUserAnswer, AskUserQuestion, ToolContext } from "./types.ts";

interface MockCtx extends ToolContext {
  /** Replay log: every setProgress call, in order. */
  progress: Array<{ progress: number; label?: string; description?: string }>;
  /** Replay log: the bag of questions each askUser call received. */
  asked: AskUserQuestion[][];
}

function makeMockCtx(answers: AskUserAnswer[][]): MockCtx {
  const remaining = [...answers];
  const ctx = {
    progress: [],
    asked: [],
    setProgress(progress: number, label?: string, description?: string) {
      ctx.progress.push({ progress, label, description });
    },
    askUser(qs: AskUserQuestion[]) {
      ctx.asked.push(qs);
      const next = remaining.shift();
      if (!next) throw new Error("askUser called more times than scripted");
      return Promise.resolve(next);
    },
    log() {},
    display: { markdown() {}, image() {}, table() {}, diff() {} },
    memories: {
      list: () => Promise.resolve([]),
      get: () => Promise.reject(new Error("not scripted")),
      write: () => Promise.reject(new Error("not scripted")),
      edit: () => Promise.reject(new Error("not scripted")),
    },
    db: {
      query: () => Promise.reject(new Error("not scripted")),
      execute: () => Promise.reject(new Error("not scripted")),
    },
    llm: { complete: () => Promise.reject(new Error("not scripted")) },
    tts: { speak: () => Promise.reject(new Error("not scripted")) },
    stt: { transcribe: () => Promise.reject(new Error("not scripted")) },
    schedulePrompt: () => Promise.reject(new Error("not scripted")),
    signal: new AbortController().signal,
    getChatContext() {
      return { userMessage: "demo me", sessionId: null };
    },
  } as MockCtx;
  return ctx;
}

Deno.test("demo: collects name, color, preferences and returns them as an object", async () => {
  const ctx = makeMockCtx([["Ada"], ["blue"], [["reading", "hiking"]]]);
  const result = await demo({}, ctx);
  assertEquals(result, {
    name: "Ada",
    color: "blue",
    preferences: ["reading", "hiking"],
  });
});

Deno.test("demo: progress callbacks fire at 0, 0.33, 0.66, 1 in order", async () => {
  const ctx = makeMockCtx([[""], [""], [[]]]);
  await demo({}, ctx);
  const values = ctx.progress.map((p) => p.progress);
  assertEquals(values, [0, 0.33, 0.66, 1]);
});

Deno.test("demo: askUser is called once per question with the expected option shape", async () => {
  const ctx = makeMockCtx([[""], [""], [[]]]);
  await demo({}, ctx);
  assertEquals(ctx.asked.length, 3);
  // Second question has options array; third is multiselect. Both are
  // choice questions (no kind), narrowed from the kind-discriminated union.
  const color = ctx.asked[1][0];
  const prefs = ctx.asked[2][0];
  if (color.kind !== undefined && color.kind !== "choice") {
    throw new Error("expected choice");
  }
  if (prefs.kind !== undefined && prefs.kind !== "choice") {
    throw new Error("expected choice");
  }
  assertEquals(color.options?.[0].value, "red");
  assertEquals(prefs.multiselect, true);
  assertEquals(prefs.allowFreeformInput, true);
});

Deno.test("demo: tolerates empty / non-string answers without crashing", async () => {
  // Each answer slot is the wrong type for what the prompt expects;
  // demo should fall back to empty defaults instead of throwing.
  const ctx = makeMockCtx([
    [["array", "but-string-expected"]],
    [["array", "but-string-expected"]],
    ["just-string-but-array-expected"],
  ]);
  const result = await demo({}, ctx);
  assertEquals(result.name, "");
  assertEquals(result.color, "");
  assertEquals(result.preferences, []);
});
