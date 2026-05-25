/**
 * App-level view mode. The client renders one of five top-level modes; this
 * store holds which one and exposes a request API for switching between them.
 *
 * The slide transition in +page.svelte is "slide out → swap content → slide
 * in", so the mode the user actually sees (`mode`) is committed at the
 * OFFSCREEN midpoint, not when the request is made. Components call
 * `navigate(next)`, which sets `pendingMode`; +page.svelte watches
 * `pendingMode`, runs the slide, and calls `commit()` mid-slide. The store
 * itself stays DOM-free — the panel element it animates lives in +page.svelte.
 */

export type AppMode = "coreManagement" | "quickSetup" | "chat" | "sessionList" | "settings";

class ViewState {
  /** The mode currently rendered. Written only by `commit()` (at the slide's
   *  offscreen midpoint) and by `setImmediate()` (the no-animation boot path). */
  mode = $state<AppMode>("chat");
  /** The requested mode. +page.svelte's $effect drives the slide toward it. */
  pendingMode = $state<AppMode>("chat");
  /** True while no core is paired: navigation away from coreManagement is
   *  blocked so the rest of the UI (which would call `cores().api()`) can't
   *  be reached. */
  locked = $state(false);

  /** Request a transition to `next`. No-ops while locked (unless the target
   *  is coreManagement) or when that mode is already pending. */
  navigate(next: AppMode): void {
    if (this.locked && next !== "coreManagement") return;
    if (this.pendingMode === next) return;
    this.pendingMode = next;
  }

  /** Commit the pending mode. Called by +page.svelte at the offscreen
   *  midpoint of the slide so the content swap is never visible. */
  commit(): void {
    this.mode = this.pendingMode;
  }

  /** Jump straight to a mode with no animation. Used by the boot path. */
  setImmediate(next: AppMode): void {
    this.mode = next;
    this.pendingMode = next;
  }

  setLocked(value: boolean): void {
    this.locked = value;
  }
}

export const viewState = new ViewState();
