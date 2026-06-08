// CoreClient surface that can be exercised without a real network. HTTP goes
// through platform().net.fetch and WebSocket through platform().net
// .connectWebSocket, so we install a fake Platform and drive those.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, CoreClient } from "./client";
import {
  type NetRequest,
  type NetResponse,
  type NetSocket,
  type Platform,
  setPlatform,
} from "../platform/index";
import type { ServerToClientFrame } from "@tomat/shared";

const ENDPOINT = { baseUrl: "https://core", token: "T", tlsPin: "PIN" };

function jsonRes(status: number, obj: unknown): NetResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(obj)),
  };
}

// A controllable NetSocket; tests fire its lifecycle callbacks by hand.
class FakeNetSocket implements NetSocket {
  opened?: () => void;
  messaged?: (d: string) => void;
  closed?: () => void;
  errored?: () => void;
  sent: string[] = [];
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {}
  onOpen(cb: () => void): void {
    this.opened = cb;
  }
  onMessage(cb: (d: string) => void): void {
    this.messaged = cb;
  }
  onClose(cb: () => void): void {
    this.closed = cb;
  }
  onError(cb: () => void): void {
    this.errored = cb;
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
  let netFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    netFetch = vi.fn();
    setPlatform({ net: { fetch: netFetch, connectWebSocket: vi.fn() } } as unknown as Platform);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends bearer header + pin on non-public calls", async () => {
    netFetch.mockResolvedValueOnce(jsonRes(200, { ok: 1 }));
    const c = new CoreClient(ENDPOINT);
    const out = await c.get<{ ok: number }>("/api/v1/x");
    expect(out).toEqual({ ok: 1 });

    const req = netFetch.mock.calls[0][0] as NetRequest;
    expect(req.url).toBe("https://core/api/v1/x");
    expect(req.headers).toMatchObject({ Authorization: "Bearer T" });
    expect(req.pin).toBe("PIN");
  });

  it("translates non-2xx JSON error body into ApiError", async () => {
    netFetch.mockResolvedValueOnce(
      jsonRes(400, { error: { code: "validation_error", message: "bad" } }),
    );
    const c = new CoreClient(ENDPOINT);
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
    netFetch.mockResolvedValueOnce({ status: 204, headers: {}, body: new Uint8Array() });
    const c = new CoreClient(ENDPOINT);
    const out = await c.del("/api/v1/x");
    expect(out).toBeUndefined();
  });
});

describe("CoreClient WebSocket dispatch", () => {
  let last: FakeNetSocket | null = null;
  beforeEach(() => {
    last = null;
    setPlatform({
      net: {
        fetch: vi.fn(),
        connectWebSocket: (_url: string) => {
          last = new FakeNetSocket();
          return Promise.resolve(last);
        },
      },
    } as unknown as Platform);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getLast(): FakeNetSocket {
    if (!last) throw new Error("no socket constructed yet");
    return last;
  }

  it("subscribe() lazily opens a socket and dispatches received frames", async () => {
    const c = new CoreClient(ENDPOINT);
    const received: ServerToClientFrame[] = [];
    c.subscribe((f) => received.push(f));
    await flush();
    const ws = getLast();
    ws.opened?.();
    const frame = { kind: "chat.chunk", streamId: "s1", contentDelta: "hi" };
    ws.messaged?.(JSON.stringify(frame));
    expect(received).toEqual([frame]);
  });

  it("subscribe() returns an unsubscribe that stops dispatch", async () => {
    const c = new CoreClient(ENDPOINT);
    const received: ServerToClientFrame[] = [];
    const unsubscribe = c.subscribe((f) => received.push(f));
    await flush();
    const ws = getLast();
    ws.opened?.();
    unsubscribe();
    ws.messaged?.(JSON.stringify({ kind: "chat.chunk", streamId: "s1", contentDelta: "x" }));
    expect(received).toEqual([]);
  });

  it("onConnectionState fires 'connected' once the socket opens", async () => {
    const c = new CoreClient(ENDPOINT);
    const states: string[] = [];
    c.onConnectionState((s) => states.push(s));
    c.subscribe(() => {});
    await flush();
    getLast().opened?.();
    expect(states[states.length - 1]).toBe("connected");
  });

  it("pong frames are dropped and not forwarded to listeners", async () => {
    const c = new CoreClient(ENDPOINT);
    const received: ServerToClientFrame[] = [];
    c.subscribe((f) => received.push(f));
    await flush();
    const ws = getLast();
    ws.opened?.();
    ws.messaged?.(JSON.stringify({ kind: "pong" }));
    expect(received).toEqual([]);
  });
});

describe("CoreClient reconnect", () => {
  let sockets: FakeNetSocket[] = [];
  beforeEach(() => {
    sockets = [];
    setPlatform({
      net: {
        fetch: vi.fn(),
        connectWebSocket: (_url: string) => {
          const s = new FakeNetSocket();
          sockets.push(s);
          return Promise.resolve(s);
        },
      },
    } as unknown as Platform);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Recovery must not depend on the transport delivering an onClose after an
  // onError: an error alone has to schedule the backoff reconnect (see the
  // onError handler in openSocket).
  it("onError alone (no following onClose) still schedules a reconnect", async () => {
    vi.useFakeTimers();
    const c = new CoreClient(ENDPOINT);
    c.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0); // resolve the connectWebSocket microtask
    expect(sockets.length).toBe(1);
    sockets[0].opened?.();

    // Error with NO onClose follow-up. The remote-core backoff starts at 500ms.
    sockets[0].errored?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets.length).toBe(2);
  });
});
