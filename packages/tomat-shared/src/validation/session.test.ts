// Message discriminated union: one parse per role, strict-mode
// rejection of cross-role fields, and PATCH schemas that don't accept
// `role` updates. This file is the contract test that prevents silent
// drift between core's appendMessage and the client's typed senders.

import { assertEquals } from "@std/assert";
import {
  assistantMessageInputSchema,
  errorMessageInputSchema,
  messageInputSchema,
  messagePatchSchemaByRole,
  reasoningMessageInputSchema,
  systemMessageInputSchema,
  toolFilterMessageInputSchema,
  toolMessageInputSchema,
  userMessageInputSchema,
} from "./session.ts";

Deno.test("messageInputSchema: parses each of the 7 roles", () => {
  const cases = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hi" },
    { role: "system", content: "sys" },
    {
      role: "tool",
      callId: "c1",
      toolkitId: "t1",
      toolName: "do",
      status: "completed",
    },
    { role: "reasoning", content: "think" },
    { role: "tool_filter", status: "complete" },
    { role: "error", content: "boom" },
  ];
  for (const c of cases) {
    const r = messageInputSchema.safeParse(c);
    assertEquals(r.success, true, `should parse role=${c.role}`);
  }
});

Deno.test("userMessageInputSchema: accepts string content and multipart array", () => {
  assertEquals(userMessageInputSchema.safeParse({ role: "user", content: "hi" }).success, true);
  assertEquals(
    userMessageInputSchema.safeParse({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    }).success,
    true,
  );
});

Deno.test("userMessageInputSchema: rejects assistant-only fields (strict mode)", () => {
  const r = userMessageInputSchema.safeParse({
    role: "user",
    content: "hi",
    streaming: true,
  });
  assertEquals(r.success, false);
});

Deno.test("assistantMessageInputSchema: rejects unknown fields and tool-only fields", () => {
  assertEquals(
    assistantMessageInputSchema.safeParse({
      role: "assistant",
      content: "ok",
      callId: "c1",
    }).success,
    false,
  );
});

Deno.test("messagePart: image_url requires nested url object (no bare string)", () => {
  assertEquals(
    userMessageInputSchema.safeParse({
      role: "user",
      content: [{ type: "image_url", image_url: "https://x" }],
    }).success,
    false,
  );
  assertEquals(
    userMessageInputSchema.safeParse({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://x" } }],
    }).success,
    true,
  );
});

Deno.test("toolMessageInputSchema: requires status from the documented enum", () => {
  assertEquals(
    toolMessageInputSchema.safeParse({
      role: "tool",
      callId: "c",
      toolkitId: "t",
      toolName: "n",
      status: "not-a-state",
    }).success,
    false,
  );
});

Deno.test("messagePatchSchemaByRole: rejects `role` in patch bodies", () => {
  const r = messagePatchSchemaByRole.user.safeParse({ role: "user" });
  assertEquals(r.success, false);
});

Deno.test("messagePatchSchemaByRole: rejects cross-role fields per role", () => {
  // Patch a UserMessage with an assistant-only field, which must fail.
  assertEquals(messagePatchSchemaByRole.user.safeParse({ streaming: true }).success, false);
  // Patch an AssistantMessage with a user-only field, which must fail.
  assertEquals(
    messagePatchSchemaByRole.assistant.safeParse({
      systemPromptOverride: "x",
    }).success,
    false,
  );
});

Deno.test("messagePatchSchemaByRole: accepts a partial of fields valid for the role", () => {
  assertEquals(messagePatchSchemaByRole.assistant.safeParse({ content: "edited" }).success, true);
  assertEquals(messagePatchSchemaByRole.assistant.safeParse({ streaming: false }).success, true);
});

Deno.test("reasoning + tool_filter + error: each parses its minimum body", () => {
  for (const [schema, body] of [
    [reasoningMessageInputSchema, { role: "reasoning", content: "" }],
    [
      toolFilterMessageInputSchema,
      {
        role: "tool_filter",
        status: "filtering",
      },
    ],
    [errorMessageInputSchema, { role: "error", content: "boom" }],
    [systemMessageInputSchema, { role: "system", content: "s" }],
  ] as const) {
    assertEquals(schema.safeParse(body).success, true);
  }
});
