// Tier 1: session management. Create a session, send into it, start a new one
// (transcript clears), and browse the session list.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { sessionsState } from "@client/state/sessions.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("starts a new session, clearing the previous transcript", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "text", text: "answer-in-session-A" } });
  await app.chat.send("a message only in session A");
  await app.chat.expectText("answer-in-session-A");

  // New session (the same call the new-session control invokes).
  await sessionsState.create();
  await app.nav.expectMode("chat");
  await expect.element(page.getByText("a message only in session A")).not.toBeInTheDocument();
});

test("lists prior sessions in the session list", async () => {
  app = await launchApp({ scenario: "paired", llm: { kind: "text", text: "ok" } });

  // First message lands in the boot session; record how many sessions exist.
  await app.chat.send("first session message");
  await sessionsState.loadList();
  const countAfterFirst = sessionsState.list.length;
  expect(countAfterFirst).toBeGreaterThanOrEqual(1);

  // Explicitly start a second session (create() sets the active id) and send.
  await sessionsState.create();
  const secondId = sessionsState.id;
  await app.chat.send("second session message");

  await app.nav.openSessions();
  await sessionsState.loadList();

  // The brand-new session is listed and the list actually grew: proves creation
  // persisted and the list reflects it (not just "some session exists").
  expect(secondId).toBeTruthy();
  expect(sessionsState.list.map((s) => s.id)).toContain(secondId);
  expect(sessionsState.list.length).toBeGreaterThan(countAfterFirst);
});
