// WS upgrade contract: bearer auth at handshake, ping/pong round-trip.
// Uses a real Deno.serve on an ephemeral port and a real WebSocket dial-back
// because `app.fetch()` can't drive Deno.upgradeWebSocket; this is the only
// way to exercise the actual upgrade hook.
//
// The chat orchestrator (chat.start through to streamed assistant deltas) is
// intentionally NOT exercised here. It requires a fake LLM endpoint and is
// a separate integration. This file only verifies the WS hub envelope.

import { assertEquals } from "@std/assert";
import { pairClient } from "../../tests/helpers/pairing.ts";
import { startTestServer } from "../../tests/helpers/serve.ts";
import { wsHub } from "./hub.ts";
import { setupTestEnv } from "../../tests/helpers/db.ts";

async function pair(): Promise<string> {
  const { token } = await pairClient("ws-test", "127.0.0.1");
  return token;
}

function dial(port: number, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/v1?token=${token}`);
}

function once<T>(ws: WebSocket, ev: "open" | "close" | "error"): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ev === "open") {
      ws.addEventListener("open", () => resolve(undefined as T), {
        once: true,
      });
      ws.addEventListener("error", reject, { once: true });
      return;
    }
    ws.addEventListener(ev, (e) => resolve(e as unknown as T), { once: true });
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      // The hub seeds every new connection with a core.status frame; skip it so
      // these protocol tests see the reply they actually probe for.
      if (data.includes('"core.status"')) return;
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("error", onErr);
      resolve(data);
    };
    const onErr = (ev: Event) => {
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("error", onErr);
      reject(ev);
    };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("error", onErr);
  });
}

Deno.test({
  name: "WS /ws/v1: ping frame is answered with a pong",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const token = await pair();
      const ws = dial(server.port, token);
      await once(ws, "open");
      ws.send(JSON.stringify({ kind: "ping" }));
      const reply = await nextMessage(ws);
      assertEquals(JSON.parse(reply), { kind: "pong" });
      ws.close();
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: upgrade without token returns 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      // Plain HTTP GET to /ws/v1 without an Upgrade header. The auth check
      // runs BEFORE the upgrade attempt, so we get the 401 directly.
      const res = await fetch(`http://127.0.0.1:${server.port}/ws/v1`);
      assertEquals(res.status, 401);
      assertEquals(await res.text(), "missing token");
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: upgrade with invalid token returns 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/ws/v1?token=not-real`);
      assertEquals(res.status, 401);
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: broadcastAll reaches every connected client",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      // Mint two distinct paired clients and connect each.
      const tokenA = await pair();
      const tokenB = await pair();
      const wsA = dial(server.port, tokenA);
      const wsB = dial(server.port, tokenB);
      await Promise.all([once(wsA, "open"), once(wsB, "open")]);

      // Fire a broadcast through the hub (synthetic; production triggers
      // come from downloadManager / sidecarManager / update subscribers).
      const recvA = nextMessage(wsA);
      const recvB = nextMessage(wsB);
      wsHub().broadcastAll({ kind: "update.staged", version: "9.9.9" });
      const [a, b] = await Promise.all([recvA, recvB]);
      assertEquals(JSON.parse(a).kind, "update.staged");
      assertEquals(JSON.parse(b).kind, "update.staged");
      wsA.close();
      wsB.close();
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: closeClient() force-closes the client's live socket",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Revoke/rotate call hub.closeClient(clientId) so a now-untrusted device's
    // long-lived socket is actually cut off (the WS only authenticates once,
    // at upgrade). Pair, connect, then close by clientId and assert the close.
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const { token, clientId } = await pairClient("ws-revoke-test", "127.0.0.1");
      const ws = dial(server.port, token);
      await once(ws, "open");
      const closed = once<CloseEvent>(ws, "close");
      wsHub().closeClient(clientId);
      const ev = await closed;
      assertEquals(ev.code, 4001);
      assertEquals(typeof ev.reason, "string");
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: malformed JSON frame is dropped, not propagated",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The hub logs a warning for invalid JSON and continues. A follow-up
    // valid frame on the same socket must still be handled, proving the
    // connection isn't torn down by the bad frame.
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const token = await pair();
      const ws = dial(server.port, token);
      await once(ws, "open");
      ws.send("not-json-at-all{");
      // Valid follow-up: ping, then expect a pong, proving the socket survived.
      ws.send(JSON.stringify({ kind: "ping" }));
      const reply = await nextMessage(ws);
      assertEquals(JSON.parse(reply), { kind: "pong" });
      ws.close();
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: frame without `kind` is dropped, socket survives",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const token = await pair();
      const ws = dial(server.port, token);
      await once(ws, "open");
      ws.send(JSON.stringify({ streamId: "x", missing: "kind" }));
      ws.send(JSON.stringify({ kind: "ping" }));
      const reply = await nextMessage(ws);
      assertEquals(JSON.parse(reply), { kind: "pong" });
      ws.close();
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

// --- settings.updated broadcasts --------------------------------------------
// A settings change also recomputes requirements (its own broadcast), so the
// helper filters by kind instead of assuming order. Like the broadcastAll
// test above, the listener MUST be registered before the triggering call:
// the frame can arrive while the trigger's await is still settling.

function waitForFrame(ws: WebSocket, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      const frame = JSON.parse(ev.data) as Record<string, unknown>;
      if (frame.kind !== kind) return;
      ws.removeEventListener("message", onMsg);
      resolve(frame);
    };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

function patchSettings(port: number, token: string, body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/api/v1/settings`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name: "WS /ws/v1: settings PATCH broadcasts settings.updated (value, then deletion)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const token = await pair();
      const ws = dial(server.port, token);
      await once(ws, "open");

      const valueFramePromise = waitForFrame(ws, "settings.updated");
      const set = await patchSettings(server.port, token, {
        "llm.host": "0.0.0.0",
      });
      assertEquals(set.status, 200);
      await set.body?.cancel();
      const valueFrame = await valueFramePromise;
      assertEquals((valueFrame.values as Record<string, unknown>)["llm.host"], "0.0.0.0");
      assertEquals(valueFrame.deleted, []);

      const deletedFramePromise = waitForFrame(ws, "settings.updated");
      const del = await patchSettings(server.port, token, { "llm.host": null });
      assertEquals(del.status, 200);
      await del.body?.cancel();
      const deletedFrame = await deletedFramePromise;
      assertEquals(deletedFrame.deleted, ["llm.host"]);
      assertEquals(deletedFrame.values, {});

      ws.close();
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: secret changes broadcast names only, never the value",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const token = await pair();
      const ws = dial(server.port, token);
      await once(ws, "open");

      const framePromise = waitForFrame(ws, "settings.updated");
      const put = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/settings/secrets/llm.external.apiKey`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value: "sk-never-on-the-wire" }),
        },
      );
      assertEquals(put.status, 204);
      await put.body?.cancel();

      const frame = await framePromise;
      assertEquals(frame.values, {});
      assertEquals(frame.deleted, []);
      assertEquals(frame.secretNames, ["llm.external.apiKey"]);
      assertEquals(JSON.stringify(frame).includes("sk-never-on-the-wire"), false);

      ws.close();
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});

Deno.test({
  name: "WS /ws/v1: secret-typed settings keys never appear in settings.updated",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = await startTestServer();
    try {
      const token = await pair();
      const ws = dial(server.port, token);
      await once(ws, "open");

      // Write a secret-typed key through the service directly (the route guard
      // would reject it), then a benign key. The next settings.updated must
      // carry only the benign key: the hub filter drops the secret even though
      // the store changed.
      const framePromise = waitForFrame(ws, "settings.updated");
      const { patchCoreSettings } = await import("@tomat/core-engine/services/core-settings");
      await patchCoreSettings({ "llm.external.apiKey": "sk-store-leak" });
      await patchCoreSettings({ "llm.host": "0.0.0.0" });

      const frame = await framePromise;
      const values = frame.values as Record<string, unknown>;
      assertEquals(values["llm.host"], "0.0.0.0");
      assertEquals("llm.external.apiKey" in values, false);
      assertEquals(JSON.stringify(frame).includes("sk-store-leak"), false);

      ws.close();
    } finally {
      await server.stop();
      await env.teardown();
    }
  },
});
