// Tier 2: general context. The user/agent names configured in General are woven
// into the per-turn context block the client sends as the system prompt, so the
// model receives them.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { settingsState } from "@client/state/settings.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("the configured user name reaches the model context", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "text", text: "ok" } });
  await app.chat.waitReady();
  await settingsState.updateSetting("general.context.userName", "Zaphod Beeblebrox");

  await app.chat.send("hi");
  await app.chat.expectText("ok");

  const reqs = await app.llmRequests();
  const sawName = reqs.some((r) =>
    r.messages.some((m) => String(m.content).includes("Zaphod Beeblebrox")),
  );
  expect(sawName).toBe(true);
});
