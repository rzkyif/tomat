// Tier 1: simple chat. A paired core, a scripted reply, and a real send ->
// stream -> render round-trip across the real client UI and a real core.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("sends a message and renders the streamed assistant reply", async () => {
  app = await launchApp({
    scenario: "paired",
    llm: { kind: "text", text: "the-assistant-reply" },
  });
  await app.chat.send("hello there");
  await app.chat.expectText("hello there"); // user bubble
  await app.chat.expectText("the-assistant-reply"); // assistant bubble
});

test("echoes the user message when scripted to echo", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "echo" } });
  await app.chat.send("unique-echo-token-42");
  // Echo means the assistant streams the same text back, so it appears twice.
  await expect.element(page.getByText("unique-echo-token-42").nth(1)).toBeVisible({
    timeout: 20_000,
  });
});

test("supports a multi-turn conversation", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "text", text: "first-answer" } });
  await app.chat.send("first question");
  await app.chat.expectText("first-answer");
  await app.setLlm({ kind: "text", text: "second-answer" });
  await app.chat.send("second question");
  await app.chat.expectText("second-answer");
});
