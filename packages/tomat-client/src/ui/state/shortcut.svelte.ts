/**
 * Listens for global-shortcut press / release events coming from the
 * Rust backend and turns them into the right app-level behavior: show
 * or hide the window, push-to-talk, sticky listen, etc., based on what
 * the user has configured.
 */

import { platform } from "$lib/platform";
import { getLogger } from "$lib/util/log";
import { vadManager } from "./vad.svelte";
import { settingsState } from "./settings.svelte";

const log = getLogger("shortcut");

/**
 * Tracks whether the main window is currently mid show / hide animation.
 *
 * Why: Rust flips its `visible` AtomicBool only after JS finishes the
 * animation, so a shortcut press during a slide would emit the
 * opposite-direction event and reverse the slide mid-flight (visible
 * flicker on spam). +page.svelte calls begin() / end() at the boundaries
 * of its animations; ShortcutHandler reads it to drop spammed presses.
 */
class WindowTransition {
  private inFlight = false;

  isTransitioning(): boolean {
    return this.inFlight;
  }

  begin() {
    this.inFlight = true;
  }

  end() {
    this.inFlight = false;
  }
}

export const windowTransition = new WindowTransition();

class ShortcutHandler {
  // Reactive: true while the push-to-talk shortcut is currently being held
  // (between press and either timer-fire or release). Drives the mic button's
  // hold-progress ring so the UI animates from 0 → 100% in lockstep with the
  // hold timer.
  pttHolding = $state(false);
  // The hold duration captured at press time (ms). Pinned for the duration
  // of the press so a settings change mid-hold can't desync the animation.
  pttHoldDuration = $state(0);

  // Regular fields - no reactivity needed, just persistent across listener
  // fires. Using `this` rather than module-scope variables ensures we never
  // read from a stale closure capture.
  private pressStart = 0;
  private wasVisibleOnPress = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  // Set when onPressed bails because a window transition is in flight, so
  // the matching onReleased is also dropped (otherwise PTT release would
  // still fire `request_hide_main_window` or toggle VAD off the half-press).
  private skipNextRelease = false;

  private unsubscribe: (() => void) | null = null;

  async attach(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = await platform().shortcuts.subscribeEvents({
      onPressed: () => this.onPressed(),
      onReleased: () => this.onReleased(),
    });
  }

  detach() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.pressStart = 0;
    this.wasVisibleOnPress = false;
    this.pttHolding = false;
    this.pttHoldDuration = 0;
    this.skipNextRelease = false;
  }

  private async onPressed() {
    // Drop presses landing while the window is mid show / hide animation.
    // Rust flips its visibility AtomicBool only after JS finishes the
    // animation, so a pass-through press would emit the opposite-direction
    // event and reverse the slide mid-flight (visible flicker on spam).
    if (windowTransition.isTransitioning()) {
      this.skipNextRelease = true;
      return;
    }

    const mode = settingsState.currentSettings["stt.activation"];
    const duration = Number(settingsState.currentSettings["stt.holdDuration"]) || 250;
    this.pressStart = Date.now();

    if (mode === "push-to-talk") {
      const visible = await platform().windowing.isVisible();
      this.wasVisibleOnPress = visible;

      if (!visible) {
        try {
          await platform().windowing.show();
        } catch (e) {
          log.warn("show failed:", e);
        }
      }

      if (this.holdTimer) clearTimeout(this.holdTimer);
      // Flip the reactive flag synchronously on press so the UI ring starts
      // animating immediately, not after the timer fires.
      this.pttHoldDuration = duration;
      this.pttHolding = true;
      this.holdTimer = setTimeout(async () => {
        this.holdTimer = null;
        this.pttHolding = false;
        if (this.pressStart && !vadManager.enabled && !vadManager.loading) {
          await vadManager.toggle();
        }
      }, duration);
    } else {
      // Manual / Sticky: defer to Rust so the shortcut and the tray icon
      // share one source of truth for visibility (avoids drift between
      // window.isVisible() on the JS side and the AtomicBool on the Rust
      // side that the tray uses).
      try {
        await platform().windowing.toggle();
      } catch (e) {
        log.warn("toggle failed:", e);
      }
    }
  }

  private async onReleased() {
    if (this.skipNextRelease) {
      this.skipNextRelease = false;
      return;
    }

    const mode = settingsState.currentSettings["stt.activation"];
    const duration = Number(settingsState.currentSettings["stt.holdDuration"]) || 250;
    const held = this.pressStart ? Date.now() - this.pressStart : 0;
    const wasVisibleOnPress = this.wasVisibleOnPress;
    this.pressStart = 0;

    if (mode !== "push-to-talk") return;

    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.pttHolding = false;

    if (held < duration) {
      // Short tap: if visible on press, hide. If hidden on press, we already
      // showed it on press - leave it visible.
      if (wasVisibleOnPress) {
        try {
          // Route through the request path so the UI animates out before
          // the native window actually hides.
          await platform().windowing.requestHide();
        } catch (e) {
          log.warn("hide failed:", e);
        }
      }
    } else if (vadManager.enabled) {
      await vadManager.toggle();
    }
  }
}

export const shortcutHandler = new ShortcutHandler();
