/**
 * Listens for global-shortcut press / release events coming from the
 * Rust backend and turns them into the right app-level behavior — show
 * or hide the window, push-to-talk, sticky listen, etc., based on what
 * the user has configured.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { vadManager } from "$lib/shared/vad.svelte";
import { settingsState } from "./settings.svelte";

async function windowIsVisible(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isVisible();
  } catch {
    return true;
  }
}

class ShortcutHandler {
  // Regular fields - no reactivity needed, just persistent across listener
  // fires. Using `this` rather than module-scope variables ensures we never
  // read from a stale closure capture.
  private pressStart = 0;
  private wasVisibleOnPress = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  private unlistenPressed: (() => void) | null = null;
  private unlistenReleased: (() => void) | null = null;

  async attach(): Promise<void> {
    if (this.unlistenPressed) return;
    this.unlistenPressed = await listen("shortcut-pressed", () => this.onPressed());
    this.unlistenReleased = await listen("shortcut-released", () => this.onReleased());
  }

  detach() {
    this.unlistenPressed?.();
    this.unlistenReleased?.();
    this.unlistenPressed = null;
    this.unlistenReleased = null;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.pressStart = 0;
    this.wasVisibleOnPress = false;
  }

  private async onPressed() {
    const mode = settingsState.currentSettings["stt.activation"];
    const duration = Number(settingsState.currentSettings["stt.holdDuration"]) || 250;
    this.pressStart = Date.now();

    if (mode === "push-to-talk") {
      const visible = await windowIsVisible();
      this.wasVisibleOnPress = visible;

      if (!visible) {
        try {
          await invoke("show_main_window");
        } catch (e) {
          console.warn("[shortcut] show failed:", e);
        }
      }

      if (this.holdTimer) clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(async () => {
        this.holdTimer = null;
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
        await invoke("toggle_main_window");
      } catch (e) {
        console.warn("[shortcut] toggle failed:", e);
      }
    }
  }

  private async onReleased() {
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

    if (held < duration) {
      // Short tap: if visible on press, hide. If hidden on press, we already
      // showed it on press - leave it visible.
      if (wasVisibleOnPress) {
        try {
          // Route through the request path so the UI animates out before
          // the native window actually hides.
          await invoke("request_hide_main_window");
        } catch (e) {
          console.warn("[shortcut] hide failed:", e);
        }
      }
    } else if (vadManager.enabled) {
      await vadManager.toggle();
    }
  }
}

export const shortcutHandler = new ShortcutHandler();
