// Tier 2: scheduled prompts. A created prompt persists and lists; running it
// fires an automated session immediately.
import { afterEach, expect, test } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { scheduledPromptsState } from "@client/state/scheduled-prompts.svelte";
import { sessionsState } from "@client/state/sessions.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("create a scheduled prompt and run it, firing an automated session", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "text", text: "scheduled reply" } });
  await app.chat.waitReady();
  await scheduledPromptsState.attach();

  const created = await scheduledPromptsState.create({
    title: "Daily check-in",
    instruction: "Summarise my day.",
    schedule: { kind: "interval", everyMinutes: 60 },
    runMissed: false,
  });
  expect(scheduledPromptsState.prompts.some((p) => p.id === created.id)).toBe(true);

  // Run it now: core opens an automated session.
  const { sessionId } = await scheduledPromptsState.run(created.id);
  expect(sessionId).toBeTruthy();

  await sessionsState.loadList();
  expect(sessionsState.list.some((s) => s.id === sessionId)).toBe(true);
});
