// Disconnect recovery: a core hot-reload drops the WS without a terminal
// chat.done/chat.error frame, so streamingState must clear isActive itself or the
// spinner spins forever. We mock $lib/core to capture the connection listener
// attach() registers, then drive a "disconnected" transition by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  connListener: null as null | ((state: string, reason?: string) => void),
}));

vi.mock("$lib/core", () => ({
  cores: () => ({
    subscribeWs: () => () => {},
    subscribeConnectionState: (l: (state: string, reason?: string) => void) => {
      hoisted.connListener = l;
      return () => {};
    },
    api: () => ({ chat: { interrupt: () => {}, start: () => {} } }),
  }),
}));

import { streamingState } from "./streaming.svelte";
import { messagesState } from "./messages.svelte";

describe("streamingState disconnect recovery", () => {
  beforeEach(() => {
    hoisted.connListener = null;
    streamingState.detach();
    streamingState.resetForSession();
    messagesState.clear();
  });
  afterEach(() => streamingState.detach());

  it("clears isActive when the connection drops mid-stream", () => {
    streamingState.attach();
    expect(hoisted.connListener).toBeTypeOf("function");
    streamingState.isActive = true;
    hoisted.connListener?.("disconnected");
    expect(streamingState.isActive).toBe(false);
  });

  it("does nothing on a connected transition", () => {
    streamingState.attach();
    streamingState.isActive = true;
    hoisted.connListener?.("connected");
    expect(streamingState.isActive).toBe(true);
  });
});
