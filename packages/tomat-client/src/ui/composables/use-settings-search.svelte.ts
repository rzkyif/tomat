/**
 * Search-mode state + a reusable slide-swap animation for the settings panel's
 * content layer. `slideSwap` runs a sequential transition: phase 1 slides the
 * current content out, phase 2 swaps it while offscreen on the opposite side,
 * phase 3 slides the new content in. It drives both entering/exiting search
 * and switching between setting groups (Settings.svelte computes the direction
 * from group order).
 *
 * "up" = current content leaves upward, new content enters from below (entering
 * search, or moving to an earlier group); "down" is the reverse.
 */

import { tick } from "svelte";
import { CSS_EASING, getDuration } from "$lib/appearance/animations";

export class SettingsSearch {
  mode = $state(false);
  query = $state("");
  layerEl: HTMLDivElement | undefined = $state();
  inputEl: HTMLInputElement | undefined = $state();

  private transitioning = false;

  /**
   * Slide the layer out in direction `dir`, run `swap` while it's offscreen on
   * the opposite side, then slide the new content in. With no layer attached
   * (tests) or animations disabled, `swap` runs synchronously and we return.
   */
  async slideSwap(dir: "up" | "down", swap: () => void): Promise<void> {
    if (this.transitioning) return;

    const dur = getDuration();

    if (this.layerEl && dur > 0) {
      this.transitioning = true;

      const outSign = dir === "up" ? 1 : -1;
      const inSign = -outSign;
      // Slide only, no cross-fade: the layer is a single element, so a pure
      // translate reads as one piece of content pushing the next in/out.
      const trans = `transform ${dur}ms ${CSS_EASING}`;

      this.layerEl.style.transition = trans;
      this.layerEl.style.transform = `translateY(${100 * outSign}%)`;
      await new Promise((r) => setTimeout(r, dur));

      swap();
      await tick();
      this.layerEl.style.transition = "none";
      this.layerEl.style.transform = `translateY(${100 * inSign}%)`;
      void this.layerEl.offsetHeight;

      this.layerEl.style.transition = trans;
      this.layerEl.style.transform = "";
      await new Promise((r) => setTimeout(r, dur));
      this.layerEl.style.transition = "";

      this.transitioning = false;
    } else {
      swap();
    }
  }

  async setMode(active: boolean): Promise<void> {
    if (this.mode === active) return;
    await this.slideSwap(active ? "up" : "down", () => {
      this.mode = active;
    });
  }

  onInput(): void {
    if (this.query.trim()) {
      void this.setMode(true);
    } else if (this.mode) {
      void this.setMode(false);
    }
  }

  clear(): void {
    this.query = "";
    void this.setMode(false);
    this.inputEl?.focus();
  }
}

export function useSettingsSearch(): SettingsSearch {
  return new SettingsSearch();
}
