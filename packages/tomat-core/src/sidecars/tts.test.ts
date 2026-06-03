// Regression: when the `deno` worker binary isn't installed, ensureLoaded()
// must REJECT cleanly (surfaced to the HTTP route) rather than orphaning the
// internal load-waiter promise into an uncaught rejection that kills the core.
// Deno's test runner fails on an unhandled rejection / op leak, so a passing
// assertRejects here also proves nothing leaked.

import { assertEquals, assertRejects } from "@std/assert";
import { setupTestEnv } from "../../tests/helpers/db.ts";
import { __resetForTesting, ttsController, ttsKillSignal } from "./tts.ts";

Deno.test("ttsKillSignal: SIGKILL on Windows (no SIGTERM there), SIGTERM elsewhere", () => {
  assertEquals(ttsKillSignal("windows"), "SIGKILL");
  assertEquals(ttsKillSignal("darwin"), "SIGTERM");
  assertEquals(ttsKillSignal("linux"), "SIGTERM");
});

Deno.test("TtsController.ensureLoaded rejects (no crash) when the deno binary is missing", async () => {
  const env = await setupTestEnv();
  __resetForTesting();
  try {
    // The fresh test env has an empty bin dir, so requireWorkerDeno() throws
    // and the spawn never happens.
    await assertRejects(() => ttsController().ensureLoaded(), Error, "deno");
  } finally {
    __resetForTesting();
    await env.teardown();
  }
});
