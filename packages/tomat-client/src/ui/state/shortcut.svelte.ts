/**
 * Listens for window-shortcut events coming from the Rust backend and turns
 * them into the right app-level behavior: show or hide the window,
 * push-to-talk, sticky listen, etc., based on what the user has configured.
 *
 * The tap-vs-hold decision itself is made in Rust (see `state::PttState` on the
 * Rust side), not here: the OS release signal reaches this webview over the
 * IPC pipe on the UI thread, which stalls exactly while the cursor is over the
 * (interactive, non-clickthrough) window, so a JS-side hold timer would promote
 * a quick tap to a hold and wrongly start STT. Rust classifies off that thread
 * and emits one semantic event - `shortcut-tap`, `shortcut-hold-start`, or
 * `shortcut-hold-end` - which we just react to. We still push the activation
 * mode + hold duration to Rust via `setPttConfig`.
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
  // (between press and either the hold verdict or a tap). Drives the mic
  // button's hold-progress ring so the UI animates from 0 → 100% over the
  // hold duration. Cosmetic, so a slightly congested webview clock is fine.
  pttHolding = $state(false);
  // The hold duration captured at press time (ms). Pinned for the duration
  // of the press so a settings change mid-hold can't desync the animation.
  pttHoldDuration = $state(0);

  // Regular fields - no reactivity needed, just persistent across listener
  // fires. Using `this` rather than module-scope variables ensures we never
  // read from a stale closure capture.
  private wasVisibleOnPress = false;
  // Set when onPressed drops its window action because a slide is in flight,
  // so the matching tap / hold-end action is dropped too (otherwise a
  // half-press would still hide the window or toggle VAD off).
  private skipNextAction = false;

  private unsubscribe: (() => void) | null = null;

  async attach(): Promise<void> {
    if (this.unsubscribe) return;
    // Make sure Rust has the current mode + hold duration before the first
    // press (settings load usually beats this, but the push is idempotent).
    await settingsState
      .applyPttConfig()
      .catch((e) => log.warn("initial PTT config sync failed:", e));
    this.unsubscribe = await platform().shortcuts.subscribeEvents({
      onPressed: () => this.onPressed(),
      onTap: () => this.onTap(),
      onHoldStart: () => this.onHoldStart(),
      onHoldEnd: () => this.onHoldEnd(),
    });
  }

  detach() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.wasVisibleOnPress = false;
    this.pttHolding = false;
    this.pttHoldDuration = 0;
    this.skipNextAction = false;
  }

  private async onPressed() {
    // Drop presses landing while the window is mid show / hide animation.
    // Rust flips its visibility AtomicBool only after JS finishes the
    // animation, so a pass-through press would emit the opposite-direction
    // event and reverse the slide mid-flight (visible flicker on spam).
    if (windowTransition.isTransitioning()) {
      this.skipNextAction = true;
      return;
    }
    this.skipNextAction = false;

    const mode = settingsState.currentSettings["stt.activation"];
    if (mode === "push-to-talk") {
      const duration = Number(settingsState.currentSettings["stt.holdDuration"]) || 250;
      const visible = await platform().windowing.isVisible();
      this.wasVisibleOnPress = visible;

      if (!visible) {
        try {
          await platform().windowing.show();
        } catch (e) {
          log.warn("show failed:", e);
        }
      }

      // Start the mic ring immediately; Rust decides tap vs hold from here.
      this.pttHoldDuration = duration;
      this.pttHolding = true;
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

  // Released before the hold threshold: a short tap. Fires the moment Rust
  // sees the release, so taps stay snappy even when the webview is busy.
  private async onTap() {
    this.pttHolding = false;
    if (this.skipNextAction) {
      this.skipNextAction = false;
      return;
    }
    if (settingsState.currentSettings["stt.activation"] !== "push-to-talk") return;
    // If visible on press, hide. If hidden on press, we already showed it on
    // press - leave it visible.
    if (this.wasVisibleOnPress) {
      try {
        // Route through the request path so the UI animates out before
        // the native window actually hides.
        await platform().windowing.requestHide();
      } catch (e) {
        log.warn("hide failed:", e);
      }
    }
  }

  // Hold threshold reached while still held: start listening.
  private async onHoldStart() {
    this.pttHolding = false;
    if (this.skipNextAction) return;
    if (settingsState.currentSettings["stt.activation"] !== "push-to-talk") return;
    if (!vadManager.enabled && !vadManager.loading) {
      await vadManager.toggle();
    }
  }

  // Released after a hold: stop listening.
  private async onHoldEnd() {
    this.pttHolding = false;
    if (this.skipNextAction) {
      this.skipNextAction = false;
      return;
    }
    if (settingsState.currentSettings["stt.activation"] !== "push-to-talk") return;
    if (vadManager.enabled) {
      await vadManager.toggle();
    }
  }
}

export const shortcutHandler = new ShortcutHandler();
