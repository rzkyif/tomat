// Tier 1: general app navigation. Move chat -> sessionList -> settings ->
// quickSettings -> chat, asserting each real mode component renders and that no
// uncaught error / render crash occurred along the way.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("navigates across every mode without a render error", async () => {
  app = await launchApp({ scenario: "paired" });
  await app.nav.expectMode("chat");
  // The chat composer is the real chat-mode landmark.
  await expect.element(page.getByTestId("composer-input")).toBeVisible();

  await app.nav.openSessions();
  await app.nav.openSettings();
  await app.nav.openQuickSettings();
  await app.nav.backToChat();
  await expect.element(page.getByTestId("composer-input")).toBeVisible();

  expect(app.uncaughtErrors(), app.uncaughtErrors().join("\n")).toEqual([]);
});
