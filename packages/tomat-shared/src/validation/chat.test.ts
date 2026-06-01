// chat-related Zod schemas. The chat WS frames are the contract between
// the client and the chat orchestrator. Strict-mode + min-length checks
// catch the common shapes silently breaking.

import { assertEquals } from "@std/assert";
import {
  chatInterruptWsSchema,
  chatRequestSchema,
  chatStartWsSchema,
  toolAskUserResponseSchema,
  toolCancelSchema,
} from "./chat.ts";

Deno.test("chatRequestSchema: route defaults to 'default' when omitted", () => {
  const r = chatRequestSchema.parse({});
  assertEquals(r.route, "default");
});

Deno.test("chatRequestSchema: rejects out-of-range temperature/topP", () => {
  assertEquals(chatRequestSchema.safeParse({ overrides: { temperature: -0.1 } }).success, false);
  assertEquals(chatRequestSchema.safeParse({ overrides: { temperature: 2.1 } }).success, false);
  assertEquals(chatRequestSchema.safeParse({ overrides: { topP: 1.1 } }).success, false);
});

Deno.test("chatRequestSchema: rejects unknown top-level fields (strict)", () => {
  assertEquals(chatRequestSchema.safeParse({ unknown: true }).success, false);
});

Deno.test("chatStartWsSchema: requires kind, streamId, sessionId", () => {
  assertEquals(
    chatStartWsSchema.safeParse({
      kind: "chat.start",
      streamId: "s1",
      sessionId: "S1",
    }).success,
    true,
  );
  assertEquals(
    chatStartWsSchema.safeParse({
      kind: "chat.start",
      streamId: "",
      sessionId: "S1",
    }).success,
    false,
  );
  assertEquals(
    chatStartWsSchema.safeParse({
      kind: "chat.notstart",
      streamId: "s1",
      sessionId: "S1",
    }).success,
    false,
  );
});

Deno.test("chatInterruptWsSchema: requires non-empty streamId", () => {
  assertEquals(
    chatInterruptWsSchema.safeParse({ kind: "chat.interrupt", streamId: "x" }).success,
    true,
  );
  assertEquals(
    chatInterruptWsSchema.safeParse({ kind: "chat.interrupt", streamId: "" }).success,
    false,
  );
});

Deno.test("toolAskUserResponseSchema: accepts string OR string[] entries in answers", () => {
  assertEquals(
    toolAskUserResponseSchema.safeParse({
      kind: "tool.askuser_response",
      callId: "c1",
      requestId: "r1",
      answers: ["one", ["a", "b"]],
    }).success,
    true,
  );
  // Numbers are not allowed.
  assertEquals(
    toolAskUserResponseSchema.safeParse({
      kind: "tool.askuser_response",
      callId: "c1",
      requestId: "r1",
      answers: [42],
    }).success,
    false,
  );
});

Deno.test("toolCancelSchema: requires non-empty callId", () => {
  assertEquals(toolCancelSchema.safeParse({ kind: "tool.cancel", callId: "c1" }).success, true);
  assertEquals(toolCancelSchema.safeParse({ kind: "tool.cancel", callId: "" }).success, false);
});
