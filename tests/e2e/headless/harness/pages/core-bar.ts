// Page object for the CoreBar: the pill showing which core the client is
// connected to and its merged status, plus the quick switcher.
//
// The shared CoreBarView renders the status pill under data-region="core-status"
// with the human label as its text ("Connecting", "Reconnecting", "Ready",
// "Re-pair needed", ...). Switching cores is driven through cores().select(id),
// the exact call CoreBar's onSwitch callback invokes, so a switch exercises the
// real client-stack core swap (close old client, build new APIs, reconnect).

import { page } from "vitest/browser";
import { expect } from "vitest";
import { cores } from "@client/lib/core/cores.ts";

export class CoreBarPage {
  /** Assert the core-status pill shows `label` (e.g. "Reconnecting", "Ready",
   *  "Re-pair needed"). The shared CoreBarView renders the label as the pill's
   *  text; the distinctive statuses are unique enough to match by text. */
  async expectStatus(label: string, timeout = 20_000): Promise<void> {
    await expect.element(page.getByText(label, { exact: false })).toBeVisible({ timeout });
  }

  /** Switch the active core by id (the call CoreBar's switcher makes). */
  async switchTo(coreId: string): Promise<void> {
    await cores().select(coreId);
  }
}
