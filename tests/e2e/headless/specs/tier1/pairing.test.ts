// Tier 1: core pairing flow. A fresh install locks to the pairing wizard; a
// completed pairing (real CPace PAKE over the core's self-signed TLS, cert-pin
// channel-bound) lands the app in chat, connected.
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("a fresh install locks to the pairing wizard", async () => {
  app = await launchApp({ scenario: "fresh" });
  await app.nav.expectMode("newCore");
  // No core paired => the chat composer is not present.
  await expect.element(page.getByTestId("composer-input")).not.toBeInTheDocument();
});

test("completing the real PAKE pairing lands in chat, connected", async () => {
  // The "paired" scenario runs the real mintCode + pairWithCode flow against the
  // spawned core (full CPace handshake, real SPKI pin), then the app boots and
  // restoreSelected() connects.
  app = await launchApp({ scenario: "paired" });
  await app.nav.expectMode("chat");
  await expect.element(page.getByTestId("composer-input")).toBeEnabled({ timeout: 20_000 });
});
