// chat orchestrator happy-path integration. Drives a single
// user-message turn end-to-end through the public seams:
//
//   HTTP /pairing → HTTP /sessions → HTTP POST /messages
//     ↓
//   WS /ws/v1 chat.start
//     ↓
//   chat.ts streams chunks → wsHub broadcasts to client
//     ↓
//   collect frames; assert chunk(s) + done arrive in order
//
// The OpenAI SDK is intercepted at globalThis.fetch — `resolveEndpoint()`
// doesn't inject a per-config fetch, but the SDK reads global fetch
// dynamically, so swapping it for the duration of the test is enough.

import { assertEquals } from "@std/assert";
import { authService } from "./auth.ts";
import { buildApp } from "../http/server.ts";
import { patchCoreSettings } from "./core-settings.ts";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { wsHub } from "../ws/hub.ts";
import { fakeOpenAIFetch } from "../../tests/helpers/fake-openai.ts";

interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

function startServer(): RunningServer {
  const app = buildApp();
  const hub = wsHub();
  const abort = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: abort.signal },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws/v1") return hub.handleUpgrade(req);
      return app.fetch(req);
    },
  );
  return {
    port: (server.addr as Deno.NetAddr).port,
    async stop() {
      abort.abort();
      await server.finished.catch(() => {});
    },
  };
}

async function pair(
  port: number,
): Promise<{ token: string; clientId: string }> {
  const { code } = await authService().mintPairingCode();
  const { token, clientId } = await authService().claim(
    code,
    "chat-t2",
    "127.0.0.1",
  );
  void port;
  return { token, clientId };
}

interface CollectedFrame {
  kind: string;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
}

function waitForFrame(
  ws: WebSocket,
  predicate: (frame: CollectedFrame) => boolean,
  timeoutMs = 5_000,
): Promise<{ matched: CollectedFrame; all: CollectedFrame[] }> {
  const all: CollectedFrame[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `timeout waiting for frame; saw ${all.length}: ${
            all.map((f) => f.kind).join(",")
          }`,
        ),
      );
    }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      const frame = JSON.parse(ev.data) as CollectedFrame;
      all.push(frame);
      if (predicate(frame)) {
        cleanup();
        resolve({ matched: frame, all });
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
    };
    ws.addEventListener("message", onMsg);
  });
}

Deno.test({
  name: "chat.start happy path: streams chunks and finishes with chat.done",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const env = await setupTestEnv();
    const server = startServer();
    const originalFetch = globalThis.fetch;
    // Intercept only the OpenAI SDK's outbound HTTP. Local-loopback
    // requests to the test server pass through to the real fetch so the
    // HTTP route tests above still work in-process.
    const openaiFetch = fakeOpenAIFetch("streaming-basic.sse");
    globalThis.fetch = ((
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;
      if (url.startsWith("https://stub.test/")) return openaiFetch(input, init);
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      // Configure external provider so chat.ts skips the local-sidecar
      // health gating and just hits our fake endpoint.
      await patchCoreSettings({
        "llm.provider": "external",
        "llm.external.baseUrl": "https://stub.test/v1",
        "llm.external.apiKey": "sk-test",
        "llm.external.model": "test-model",
      });
      const { token, clientId } = await pair(server.port);

      // Create a session over HTTP.
      const created = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/sessions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "" }),
        },
      );
      const session = await created.json();

      // Seed a user message via the messages endpoint so chat has something
      // to respond to.
      await fetch(
        `http://127.0.0.1:${server.port}/api/v1/sessions/${session.id}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ role: "user", content: "hi" }),
        },
      );

      // Open WS and send chat.start.
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/v1?token=${token}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      const streamId = "stream-1";
      const done = waitForFrame(ws, (f) => f.kind === "chat.done");
      ws.send(JSON.stringify({
        kind: "chat.start",
        streamId,
        sessionId: session.id,
        route: "default",
      }));
      const { all } = await done;

      // Assert: at least one chat.chunk arrived with our fixture content,
      // a chat.done arrived, and no chat.error was emitted.
      const chunks = all.filter((f) => f.kind === "chat.chunk");
      const errors = all.filter((f) => f.kind === "chat.error");
      assertEquals(errors.length, 0);
      assertEquals(chunks.length >= 1, true);
      const text = chunks.map((c) => c.contentDelta ?? "").join("");
      assertEquals(text.includes("Hello world"), true);
      void clientId;
      ws.close();
    } finally {
      globalThis.fetch = originalFetch;
      await server.stop();
      await env.teardown();
    }
  },
});
