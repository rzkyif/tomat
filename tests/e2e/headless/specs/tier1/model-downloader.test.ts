// Tier 1: model downloader. A core missing a required model surfaces a pending
// state that gates chat; approving the download fetches the file (the mock HF
// host streams it from the local cache, so the app "believes" it downloaded),
// the requirements clear, and chat enables.
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { launchApp, type AppHandle } from "../../harness/app.ts";
import { cores } from "@client/lib/core/cores.ts";
import { downloadsState } from "@client/state/downloads.svelte";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

test("a missing required model gates chat until downloaded", async () => {
  app = await launchApp({ scenario: "paired", models: "absent" });

  // Pending: the composer is disabled while a required model is missing. Wait
  // for the requirements snapshot to report pending (downloadsState is a
  // singleton, so a prior spec may have left it not-pending until this boot's
  // snapshot lands).
  await expect.element(page.getByTestId("composer-input")).toBeDisabled({ timeout: 20_000 });
  await vi.waitFor(() => expect(downloadsState.hasPending).toBe(true), {
    timeout: 20_000,
    interval: 300,
  });

  // Approve + download every missing model (the call the Pending Downloads modal
  // makes). The mock HF host serves the bytes from the shared cache.
  const items = downloadsState.missing
    .filter((m) => m.type === "model")
    .map((m) => ({ source: m.source }));
  expect(items.length).toBeGreaterThan(0);
  await cores().api().models.download({ items });

  // Poll the requirements snapshot until the file has landed (and verified: the
  // mock HF host serves a real `x-linked-etag`, so core's sha256 check runs).
  await vi.waitFor(
    async () => {
      await downloadsState.refetchRequirements();
      expect(downloadsState.hasPending).toBe(false);
    },
    { timeout: 40_000, interval: 500 },
  );

  // Chat enables once nothing is pending.
  await expect.element(page.getByTestId("composer-input")).toBeEnabled({ timeout: 20_000 });
}, 90_000);
