/**
 * Search-mode state + the slide-swap animation between the group list and
 * the search results layer. Sequential transition: phase 1 slides the
 * current content out in the direction the next mode "leaves" toward,
 * phase 2 swaps content while offscreen on the opposite side, phase 3
 * slides it in.
 *
 * "up" = entering search (search lives conceptually above the group list);
 * "down" = exiting search.
 */

import { tick } from "svelte";
import { CSS_EASING, getDuration } from "$lib/shared/animations";

export class SettingsSearch {
  mode = $state(false);
  query = $state("");
  layerEl: HTMLDivElement | undefined = $state();
  inputEl: HTMLInputElement | undefined = $state();

  private transitioning = false;

  async setMode(active: boolean): Promise<void> {
    if (this.mode === active || this.transitioning) return;

    const dir: "up" | "down" = active ? "up" : "down";
    const dur = getDuration();

    if (this.layerEl && dur > 0) {
      this.transitioning = true;

      const outSign = dir === "up" ? 1 : -1;
      const inSign = -outSign;
      const trans = `transform ${dur}ms ${CSS_EASING}, opacity ${dur}ms ${CSS_EASING}`;

      this.layerEl.style.transition = trans;
      this.layerEl.style.transform = `translateY(${100 * outSign}%)`;
      this.layerEl.style.opacity = "0";
      await new Promise((r) => setTimeout(r, dur));

      this.mode = active;
      await tick();
      this.layerEl.style.transition = "none";
      this.layerEl.style.transform = `translateY(${100 * inSign}%)`;
      this.layerEl.style.opacity = "0";
      void this.layerEl.offsetHeight;

      this.layerEl.style.transition = trans;
      this.layerEl.style.transform = "";
      this.layerEl.style.opacity = "1";
      await new Promise((r) => setTimeout(r, dur));
      this.layerEl.style.transition = "";

      this.transitioning = false;
    } else {
      this.mode = active;
    }
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
