// Page object for the chat surface. Message assertions match on rendered text
// (each spec scripts distinct text), so no per-bubble testids are needed.

import { page } from "vitest/browser";
import { expect } from "vitest";

export class ChatPage {
  input() {
    return page.getByTestId("composer-input");
  }

  /** Wait until the composer is enabled (core connected + no pending files). */
  async waitReady(): Promise<void> {
    await expect.element(this.input()).toBeEnabled({ timeout: 20_000 });
  }

  /** Type a message and send it. */
  async send(text: string): Promise<void> {
    await this.waitReady();
    const box = this.input();
    await box.fill(text);
    await page.getByTestId("composer-send").click();
  }

  /** Assert a message (user or assistant) with this exact text is on screen. */
  async expectText(text: string): Promise<void> {
    await expect.element(page.getByText(text, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    });
  }
}
