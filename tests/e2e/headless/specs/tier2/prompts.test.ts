// Tier 2: custom prompts. A custom default system prompt reaches the LLM: the
// mock records the request, so we can assert the system message carried it.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("a custom system prompt is sent to the model", async () => {
  const marker = "CUSTOM_SYSTEM_PROMPT_MARKER_7Q";
  app = await launchApp({
    scenario: "paired",
    llm: { kind: "text", text: "ok" },
    settings: {
      "prompts.defaultSystemPrompt.preset": "custom",
      "prompts.defaultSystemPrompt": marker,
    },
  });
  await app.chat.send("hello");
  await app.chat.expectText("ok");

  const reqs = await app.llmRequests();
  expect(reqs.length).toBeGreaterThan(0);
  const sentSystemPrompt = reqs.some((r) =>
    r.messages.some((m) => m.role === "system" && String(m.content).includes(marker)),
  );
  expect(sentSystemPrompt).toBe(true);
});
