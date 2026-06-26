// Tier 1: reconnect / resilience. Only this lane can exercise it: a real WS to a
// real core that genuinely drops and comes back. Killing the core (keeping its
// home + port + TLS pin) makes the client lose the socket and start
// reconnecting; bringing it back lets the same paired client reconnect with no
// re-pair, and the session resyncs.
// NOTE (behaviour delta): the "unauthorized" / "Re-pair needed" state is NOT
// reachable in this lane. The client only enters it when the WS handshake error
// carries "HTTP 401"/"HTTP 403" (client.ts isAuthRejection), and the browser
// WebSocket API hides the upgrade status - so a revoked token reads as an
// ordinary drop and the client just keeps retrying. That path is covered by the
// Rust net unit tests + the tauri-driver smoke lane, where the transport sees
// the handshake status. Here we cover the genuinely observable case: a dropped
// core that reconnects and resumes.
import { afterEach, expect, test, vi } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { connectionState } from "@client/state/connection.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("a dropped core shows Reconnecting, then recovers when it returns", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "text", text: "first reply" } });
  await app.chat.waitReady();
  await app.chat.send("before the drop");
  await app.chat.expectText("first reply");
  expect(connectionState.state).toBe("connected");

  // Kill the core (home + port preserved). The browser WS drops; the client
  // leaves "connected" and, past the banner delay, enters the reconnecting state.
  await app.killCore();
  await vi.waitFor(() => expect(connectionState.reconnecting).toBe(true), {
    timeout: 15_000,
    interval: 200,
  });

  // The CoreBar (shown in the session list) reflects it as "Reconnecting".
  await app.nav.openSessions();
  await app.coreBar.expectStatus("Reconnecting");
  await app.nav.backToChat();

  // Bring the same core back: same TLS pin, so the paired client reconnects with
  // no re-pair. Connection returns and chat works again.
  await app.bringCoreBack();
  await vi.waitFor(() => expect(connectionState.state).toBe("connected"), {
    timeout: 20_000,
    interval: 200,
  });

  await app.setLlm({ kind: "text", text: "second reply" });
  await app.chat.send("after recovery");
  await app.chat.expectText("second reply");
}, 60_000);
