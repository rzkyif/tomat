// Tier 2: appearance. Changing appearance settings applies to the live DOM
// (the real use-theme effects run on the mounted app).
import { afterEach, expect, test, vi } from "vitest";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { settingsState } from "@client/state/settings.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("theme + text size changes apply to the document element", async () => {
  app = await launchApp({ scenario: "paired" });
  await app.chat.waitReady();

  await settingsState.updateSetting("appearance.theme", "dark");
  await vi.waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true), {
    timeout: 5000,
  });

  await settingsState.updateSetting("appearance.textSize", 24);
  await vi.waitFor(() => expect(document.documentElement.style.fontSize).toBe("24px"), {
    timeout: 5000,
  });
});
