// CoreClient surface that can be exercised without a real network.
// Backoff math + reconnect orchestration is timer-heavy; we cover the
// pure observable hooks (ApiError + connectionState + frame dispatch via
// a stub WebSocket).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, CoreClient } from "./client";
import type { ServerToClientFrame } from "@tomat/shared";

describe("ApiError", () => {
  it("captures status + code + message from the error body", () => {
    const err = new ApiError(404, {
      code: "session_not_found",
      message: "no such session",
    });
    expect(err.status).toBe(404);
    expect(err.code).toBe("session_not_found");
    expect(err.message).toBe("no such session");
    expect(err.details).toBeUndefined();
  });

  it("preserves details when present", () => {
    const err = new ApiError(412, {
      code: "permissions_required",
      message: "missing",
      details: { missing: ["net://x"] },
    });
    expect(err.details).toEqual({ missing: ["net://x"] });
  });
});

describe("CoreClient HTTP", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends bearer header on non-public calls", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const c = new CoreClient({ baseUrl: "http://core", token: "T" });
    const out = await c.get<{ ok: number }>("/api/v1/x");
    expect(out).toEqual({ ok: 1 });

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit | undefined)?.headers as Record<string, string>).toMatchObject({
      Authorization: "Bearer T",
    });
  });

  it("translates non-2xx JSON error body into ApiError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "validation_error", message: "bad" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const c = new CoreClient({ baseUrl: "http://core", token: "T" });
    try {
      await c.get("/api/v1/x");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("validation_error");
      expect((e as ApiError).status).toBe(400);
    }
  });

  it("returns undefined for 204 responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const c = new CoreClient({ baseUrl: "http://core", token: "T" });
    const out = await c.del("/api/v1/x");
    expect(out).toBeUndefined();
  });
});

// --- WebSocket stub harness -------------------------------------------------

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  // Manual event firing in tests.
  private listeners = new Map<string, Set<(e: Event) => void>>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(kind: string, fn: (e: Event) => void): void {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind)!.add(fn);
  }
  removeEventListener(kind: string, fn: (e: Event) => void): void {
    this.listeners.get(kind)?.delete(fn);
  }
  fire(kind: string, ev: Partial<Event> = {}): void {
    for (const l of this.listeners.get(kind) ?? []) {
      l(ev as Event);
    }
  }
  send(_data: string): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", { code: 1000 } as unknown as Event);
  }
}

describe("CoreClient WebSocket dispatch", () => {
  let originalWs: typeof WebSocket;
  beforeEach(() => {
    originalWs = globalThis.WebSocket;
    // The harness's last-constructed instance is captured here so the test
    // can fire fake events at it.
    let last: FakeWebSocket | null = null;
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = new Proxy(
      FakeWebSocket as unknown as typeof WebSocket,
      {
        construct(_t, args) {
          last = new FakeWebSocket(args[0] as string);
          return last as unknown as WebSocket;
        },
      },
    );
    (globalThis as unknown as { __lastFakeWs: () => FakeWebSocket | null }).__lastFakeWs = () =>
      last;
  });
  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWs;
  });

  function getLast(): FakeWebSocket {
    const f = (
      globalThis as unknown as { __lastFakeWs: () => FakeWebSocket | null }
    ).__lastFakeWs();
    if (!f) throw new Error("no WebSocket constructed yet");
    return f;
  }

  it("subscribe() lazily opens a WebSocket and dispatches received frames", () => {
    const c = new CoreClient({ baseUrl: "http://core", token: "T" });
    const received: ServerToClientFrame[] = [];
    c.subscribe((f) => received.push(f));
    const ws = getLast();
    expect(ws.url.startsWith("ws://core")).toBe(true);

    // Simulate a chat.chunk frame coming over the wire. (The Zod
    // discriminated union in serverToClientFrameSchema rejects unknown
    // `kind` values, so the test has to use a real one.)
    ws.fire("open");
    const frame = { kind: "chat.chunk", streamId: "s1", contentDelta: "hi" };
    ws.fire("message", { data: JSON.stringify(frame) } as unknown as Event);

    expect(received).toEqual([frame]);
  });

  it("subscribe() returns an unsubscribe that stops dispatch", () => {
    const c = new CoreClient({ baseUrl: "http://core", token: "T" });
    const received: ServerToClientFrame[] = [];
    const unsubscribe = c.subscribe((f) => received.push(f));
    const ws = getLast();
    ws.fire("open");
    unsubscribe();
    ws.fire("message", {
      data: JSON.stringify({ kind: "chat.chunk", streamId: "s1", contentDelta: "x" }),
    } as unknown as Event);
    expect(received).toEqual([]);
  });

  it("onConnectionState fires 'connected' once the socket opens", async () => {
    const c = new CoreClient({ baseUrl: "http://core", token: "T" });
    const states: string[] = [];
    c.onConnectionState((s) => states.push(s));
    c.subscribe(() => {});
    const ws = getLast();
    ws.fire("open");
    // Drain microtasks so onConnectionState's queued initial callback runs.
    await Promise.resolve();
    // First state (queued microtask): the snapshot at register time.
    // Then "connecting" (set immediately by connectWs), then "connected".
    expect(states[states.length - 1]).toBe("connected");
  });

  it("pong frames are dropped and not forwarded to listeners", () => {
    const c = new CoreClient({ baseUrl: "http://core", token: "T" });
    const received: ServerToClientFrame[] = [];
    c.subscribe((f) => received.push(f));
    const ws = getLast();
    ws.fire("open");
    ws.fire("message", {
      data: JSON.stringify({ kind: "pong" }),
    } as unknown as Event);
    expect(received).toEqual([]);
  });
});
