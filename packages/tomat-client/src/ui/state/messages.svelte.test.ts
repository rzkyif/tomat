// The server-driven message reducer: applyServerMessage placement + ephemera
// preservation, appendDelta, applyToolEvent, and the disconnect fixup that
// unwedges running tool-call bubbles when the core connection drops mid-call.

import { beforeEach, describe, expect, it } from "vitest";
import type { Message as ServerMessage } from "@tomat/shared";
import { messagesState } from "./messages.svelte";
import type { Message, ToolCallStatus } from "$lib/util/types";

function toolMessage(id: string, status: ToolCallStatus, callId = id): Message {
  return {
    id,
    role: "tool",
    callId,
    toolkitId: "kit",
    toolName: "do",
    arguments: "{}",
    status,
  };
}

function serverMsg(m: Message): ServerMessage {
  return m as unknown as ServerMessage;
}

describe("messagesState.applyServerMessage", () => {
  beforeEach(() => messagesState.clear());

  it("inserts at the chronological slot after afterId", () => {
    messagesState.hydrate(
      [
        { id: "u2", role: "user", content: "two" },
        { id: "a1", role: "assistant", content: "one" },
        { id: "u1", role: "user", content: "one" },
      ],
      null,
    );
    // Born after u1 (mid-history regenerate slot): lands just before u1 in
    // the newest-first array.
    messagesState.applyServerMessage(serverMsg({ id: "r1", role: "reasoning", content: "" }), "u1");
    expect(messagesState.messages.map((m) => m.id)).toEqual(["u2", "a1", "r1", "u1"]);
  });

  it("falls back to newest position for null or unknown afterId", () => {
    messagesState.hydrate([{ id: "u1", role: "user", content: "one" }], null);
    messagesState.applyServerMessage(serverMsg({ id: "a1", role: "assistant", content: "" }), null);
    messagesState.applyServerMessage(
      serverMsg({ id: "a2", role: "assistant", content: "" }),
      "missing",
    );
    expect(messagesState.messages.map((m) => m.id)).toEqual(["a2", "a1", "u1"]);
  });

  it("replaces in place on a known id, preserving ephemera", () => {
    messagesState.hydrate([toolMessage("t1", "running")], null);
    messagesState.applyToolEvent({
      kind: "tool.log",
      callId: "t1",
      level: "info",
      message: "hello",
    });
    expect(messagesState.messages[0].ephemera?.logs).toHaveLength(1);
    messagesState.applyServerMessage(serverMsg(toolMessage("t1", "completed")), null);
    expect(messagesState.messages).toHaveLength(1);
    expect(messagesState.messages[0].status).toBe("completed");
    expect(messagesState.messages[0].ephemera?.logs).toHaveLength(1);
  });
});

describe("messagesState.appendDelta", () => {
  beforeEach(() => messagesState.clear());

  it("appends to the message's content and returns the full text", () => {
    messagesState.hydrate([{ id: "a1", role: "assistant", content: "Hello" }], null);
    expect(messagesState.appendDelta("a1", ", world")).toBe("Hello, world");
    expect(messagesState.messages[0].content).toBe("Hello, world");
    expect(messagesState.appendDelta("missing", "x")).toBeNull();
  });
});

describe("messagesState.applyToolEvent", () => {
  beforeEach(() => messagesState.clear());

  it("patches flat tool fields by callId", () => {
    messagesState.hydrate([toolMessage("t1", "running")], null);
    messagesState.applyToolEvent({
      kind: "tool.progress",
      callId: "t1",
      progress: 0.5,
      label: "Halfway",
    });
    expect(messagesState.messages[0].progress).toBe(0.5);
    expect(messagesState.messages[0].label).toBe("Halfway");
    messagesState.applyToolEvent({ kind: "tool.result", callId: "t1", result: { ok: true } });
    expect(messagesState.messages[0].status).toBe("completed");
    expect(messagesState.messages[0].result).toEqual({ ok: true });
  });
});

describe("messagesState.interruptActiveToolCalls", () => {
  beforeEach(() => messagesState.clear());

  it("flips in-flight tool calls to failed/interrupted and returns the count", () => {
    messagesState.hydrate(
      [
        toolMessage("a", "running"),
        toolMessage("b", "pending", "cb"),
        toolMessage("c", "awaiting_user", "cc"),
      ],
      null,
    );
    const changed = messagesState.interruptActiveToolCalls();
    expect(changed).toBe(3);
    for (const m of messagesState.messages) {
      expect(m.status).toBe("failed");
      expect(m.error).toBe("interrupted: core was disconnected mid-call");
    }
  });

  it("leaves terminal tool calls untouched", () => {
    messagesState.hydrate(
      [
        toolMessage("a", "completed"),
        toolMessage("b", "failed", "cb"),
        toolMessage("c", "cancelled", "cc"),
      ],
      null,
    );
    const changed = messagesState.interruptActiveToolCalls();
    expect(changed).toBe(0);
    expect(messagesState.messages.map((m) => m.status)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("preserves an existing error message", () => {
    messagesState.hydrate([{ ...toolMessage("a", "running"), error: "boom" }], null);
    messagesState.interruptActiveToolCalls();
    expect(messagesState.messages[0].error).toBe("boom");
  });
});
