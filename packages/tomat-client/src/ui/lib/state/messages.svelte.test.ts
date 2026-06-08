// interruptActiveToolCalls: the disconnect fixup that unwedges running tool-call
// bubbles when the core connection drops mid-call (e.g. a dev hot-reload).

import { beforeEach, describe, expect, it } from "vitest";
import { messagesState } from "./messages.svelte";
import type { Message, ToolCallState } from "$lib/shared/types";

function toolCall(status: ToolCallState["status"]): ToolCallState {
  return {
    callId: "c1",
    toolCallId: "tc1",
    toolkitId: "kit",
    toolName: "do",
    arguments: {},
    status,
    logs: [],
  };
}

function toolMessage(id: string, status: ToolCallState["status"]): Message {
  return { id, role: "tool", content: "", toolCall: toolCall(status) };
}

describe("messagesState.interruptActiveToolCalls", () => {
  beforeEach(() => messagesState.clear());

  it("flips in-flight tool calls to failed/interrupted and returns the count", () => {
    messagesState.hydrate(
      [toolMessage("a", "running"), toolMessage("b", "pending"), toolMessage("c", "awaiting_user")],
      null,
    );
    const changed = messagesState.interruptActiveToolCalls();
    expect(changed).toBe(3);
    for (const m of messagesState.messages) {
      expect(m.toolCall?.status).toBe("failed");
      expect(m.toolCall?.error).toBe("interrupted: core was disconnected mid-call");
    }
  });

  it("leaves terminal tool calls untouched", () => {
    messagesState.hydrate(
      [toolMessage("a", "complete"), toolMessage("b", "failed"), toolMessage("c", "cancelled")],
      null,
    );
    const changed = messagesState.interruptActiveToolCalls();
    expect(changed).toBe(0);
    expect(messagesState.messages.map((m) => m.toolCall?.status)).toEqual([
      "complete",
      "failed",
      "cancelled",
    ]);
  });

  it("preserves an existing error message", () => {
    const tc = { ...toolCall("running"), error: "boom" };
    messagesState.hydrate([{ id: "a", role: "tool", content: "", toolCall: tc }], null);
    messagesState.interruptActiveToolCalls();
    expect(messagesState.messages[0].toolCall?.error).toBe("boom");
  });
});
