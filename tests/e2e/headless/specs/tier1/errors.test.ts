// Tier 1: wire-only sad paths. These negatives only emerge from the real
// client<->core wire and cannot be faithfully unit-tested (a unit test would
// mock the very boundary under test). Everything else stays happy-path here; sad
// paths with a faithful seam live in co-located unit/component tests.
import { afterEach, expect, test, vi } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { mintCodeWithAdminToken, pairWithCode } from "@client/lib/core/pairing.ts";
import { messagesState } from "@client/state/messages.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("pairing with a wrong code is rejected by the real PAKE", async () => {
  app = await launchApp({ scenario: "fresh" });

  // A real code is minted on the core; the client then attempts the PAKE with a
  // different code. The confirmation MAC can't match, so the core rejects it.
  const { code } = await mintCodeWithAdminToken(app.baseUrl, app.adminToken);
  const wrong = code === "000000" ? "111111" : "000000";

  await expect(pairWithCode(app.baseUrl, "wrong-code-client", wrong, false)).rejects.toThrow();
}, 60_000);

test("a provider error mid-stream surfaces an error, and chat recovers", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "errorMidStream", afterChars: 10 } });
  await app.chat.waitReady();

  await app.chat.send("this turn breaks");

  // The dropped stream surfaces as an error message in the transcript.
  await vi.waitFor(
    () => expect(messagesState.messages.some((m) => m.role === "error")).toBe(true),
    {
      timeout: 20_000,
      interval: 200,
    },
  );

  // The session recovers: a normal turn works right after.
  await app.setLlm({ kind: "text", text: "recovered fine" });
  await app.chat.send("try again");
  await app.chat.expectText("recovered fine");
}, 60_000);
