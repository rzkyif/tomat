// Page object for the settings surface. Fields are keyed by their setting id
// (data-testid="setting-<id>") so specs can target a control without coupling to
// markup. Group nav items carry data-testid="settings-group-<id>".

import { page } from "vitest/browser";
import { expect } from "vitest";

export class SettingsPage {
  async openGroup(groupId: string): Promise<void> {
    await page.getByTestId(`settings-group-${groupId}`).click();
  }

  field(settingId: string) {
    return page.getByTestId(`setting-${settingId}`);
  }

  /** Toggle a boolean setting's checkbox/switch. */
  async toggle(settingId: string): Promise<void> {
    await this.field(settingId).click();
  }

  async expectVisible(settingId: string): Promise<void> {
    await expect.element(this.field(settingId)).toBeVisible({ timeout: 10_000 });
  }
}
