// Page object for top-level navigation between app modes.
//
// Navigation is driven through viewState.navigate(), which is the exact call the
// real nav controls invoke (the gear button, the session-list button, the back
// arrow all call viewState.navigate). The real mode component renders on each
// transition, so asserting the mode marker + a console-error guard exercises the
// real rendering/navigation path. The active mode is surfaced by E2eApp as a
// reactive data-testid="mode-<name>" marker.

import { page } from "vitest/browser";
import { expect } from "vitest";
import { viewState } from "@client/state/index.ts";

export type AppMode = "newCore" | "quickSettings" | "chat" | "sessionList" | "settings";

export class NavPage {
  marker(name: AppMode) {
    return page.getByTestId(`mode-${name}`);
  }

  async expectMode(name: AppMode): Promise<void> {
    await expect.element(this.marker(name)).toBeVisible({ timeout: 15_000 });
  }

  async goto(name: AppMode): Promise<void> {
    viewState.navigate(name);
    await this.expectMode(name);
  }

  openSessions(): Promise<void> {
    return this.goto("sessionList");
  }
  openSettings(): Promise<void> {
    return this.goto("settings");
  }
  openQuickSettings(): Promise<void> {
    return this.goto("quickSettings");
  }
  backToChat(): Promise<void> {
    return this.goto("chat");
  }
}
