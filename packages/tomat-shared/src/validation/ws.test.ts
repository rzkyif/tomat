// Server->client WS frame validation. The client decodes every inbound frame
// through `serverToClientFrameSchema` and DROPS anything that fails the
// discriminated union. A `kind` present in the TS union but missing a Zod
// variant therefore vanishes silently at runtime: that is exactly how
// `requirements.snapshot` broadcasts were being discarded, freezing the
// pending-downloads popup on its boot-time HTTP snapshot.

import { assertEquals } from "@std/assert";
import { serverToClientFrameSchema } from "./ws.ts";

Deno.test("serverToClientFrameSchema: accepts requirements.snapshot", () => {
  const frame = {
    kind: "requirements.snapshot",
    required: [{ source: "@unsloth/Qwen3.5-2B-GGUF/main/Qwen3.5-2B-Q4_K_M.gguf", type: "model" }],
    missing: [{ source: "@unsloth/Qwen3.5-2B-GGUF/main/Qwen3.5-2B-Q4_K_M.gguf", type: "model" }],
  };
  assertEquals(serverToClientFrameSchema.safeParse(frame).success, true);
});

Deno.test("serverToClientFrameSchema: accepts settings.updated (with and without secretNames)", () => {
  const frame = {
    kind: "settings.updated",
    values: { "tts.enabled": true },
    deleted: ["llm.modelPath"],
  };
  assertEquals(serverToClientFrameSchema.safeParse(frame).success, true);
  assertEquals(
    serverToClientFrameSchema.safeParse({
      kind: "settings.updated",
      values: {},
      deleted: [],
      secretNames: ["llm.external.apiKey"],
    }).success,
    true,
  );
});

Deno.test("serverToClientFrameSchema: every server->client kind has a variant", () => {
  // Mirrors the ServerToClientFrame union in ../api/ws.ts. Add a kind here when
  // you add one there; the assertion below then forces a matching Zod variant
  // so the frame can't be silently dropped on the client.
  const expected = new Set([
    "pong",
    "ping",
    "chat.message",
    "chat.delta",
    "chat.usage",
    "chat.done",
    "chat.error",
    "tool.progress",
    "tool.askuser_request",
    "tool.permission_request",
    "tool.log",
    "tool.result",
    "tool.error",
    "tool.cancelled",
    "toolkit.install_log",
    "toolkit.install_done",
    "toolkit.snapshot",
    "downloads.snapshot",
    "requirements.snapshot",
    "settings.updated",
    "sidecar.status",
    "session.updated",
    "session.created",
    "schedule.confirm_request",
    "update.staged",
    "update.error",
  ]);
  const covered = new Set(
    serverToClientFrameSchema.options.map((o) => o.shape.kind.value as string),
  );
  assertEquals(covered, expected);
});
