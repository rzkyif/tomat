/**
 * Take screenshots of the user's monitors. Lists available monitors and
 * captures one as a base64 PNG, briefly hiding the app window first so it
 * doesn't show up in the screenshot.
 *
 * Also exposes a region-capture flow that opens a transparent fullscreen
 * overlay window on the active monitor and returns the user-selected
 * rectangle as a base64 PNG.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CaptureMonitorInfo {
  id: string;
  name: string;
  isPrimary: boolean;
  /** Physical-pixel bounds in the virtual desktop. Mirrors xcap's monitor
   *  geometry so the region-capture flow can match against Tauri's
   *  `currentMonitor()` position without relying on names matching. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function listCaptureMonitors(): Promise<CaptureMonitorInfo[]> {
  try {
    return (await invoke("list_capture_monitors")) as CaptureMonitorInfo[];
  } catch (e) {
    console.warn("[capture] Failed to list monitors:", e);
    return [];
  }
}

/** Capture a monitor as a base64 PNG. Hides the app window during the capture
 *  if it was visible, and restores it afterwards. Returns null on failure. */
export async function captureMonitor(monitorId: string): Promise<string | null> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();

  let shouldHide = false;
  try {
    shouldHide = (await win.isVisible()) ?? false;
  } catch (e) {
    console.warn("[capture] Failed to check window visibility:", e);
  }

  try {
    if (shouldHide) {
      await invoke("hide_main_window");
      // Compositor lag: after hide() resolves, the window may still be on
      // screen on slow compositors (notably tiling WMs on X11). 180 ms
      // empirically covers observed cases without noticeable capture delay.
      await new Promise((r) => setTimeout(r, 180));
    }
    return (await invoke("capture_monitor", { monitorId })) as string;
  } catch (e) {
    console.error("[capture] Failed to capture monitor:", e);
    return null;
  } finally {
    if (shouldHide) {
      try {
        await invoke("show_main_window");
      } catch (e) {
        console.warn("[capture] Failed to restore window:", e);
      }
    }
  }
}

/** Show a fullscreen transparent overlay on the active monitor, let the user
 *  drag a rectangle, capture that region, and return the base64 PNG. Returns
 *  null on cancellation (ESC, click outside, or capture failure).
 *
 *  Hides the main window for the duration so the overlay sits alone. The
 *  overlay window is positioned and shown by a Rust command. Keeps the
 *  logical/physical pixel math out of the JS side, where it'd have to wrestle
 *  with macOS retina + multi-monitor edge cases.
 */
export async function captureRegion(): Promise<string | null> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const main = getCurrentWindow();

  let mainWasVisible = false;
  try {
    mainWasVisible = (await main.isVisible()) ?? false;
  } catch (e) {
    console.warn("[capture] visibility check failed:", e);
  }

  const unlisteners: UnlistenFn[] = [];

  try {
    if (mainWasVisible) {
      await invoke("hide_main_window");
      // Compositor lag, see captureMonitor()'s comment.
      await new Promise((r) => setTimeout(r, 180));
    }

    // Set up the result-listener BEFORE the overlay shows: a fast
    // drag-release or ESC press on the page could otherwise fire before the
    // listener attaches and the event would be lost.
    let resolveResult!: (v: string | null) => void;
    const resultPromise = new Promise<string | null>((r) => {
      resolveResult = r;
    });
    let settled = false;
    const settle = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolveResult(v);
    };
    unlisteners.push(
      await listen<string>("region-capture-result", (e) => settle(e.payload || null)),
    );
    unlisteners.push(await listen("region-capture-cancelled", () => settle(null)));

    // Position + size + show the overlay in one Rust call. Returns the
    // xcap monitor id that matches the active monitor; we stash it so the
    // page can pass it back to `capture_monitor_region`.
    const xcapMonitorId = await invoke<string>("show_region_capture_overlay");
    try {
      await invoke("set_region_capture_target", { monitorId: xcapMonitorId });
    } catch (e) {
      console.warn("[capture] set_region_capture_target failed:", e);
    }

    return await resultPromise;
  } catch (e) {
    console.error("[capture] region capture failed:", e);
    return null;
  } finally {
    for (const u of unlisteners) u();
    try {
      await invoke("hide_region_capture_overlay");
    } catch {
      // ignore
    }
    if (mainWasVisible) {
      try {
        await invoke("show_main_window");
      } catch (e) {
        console.warn("[capture] restore main window failed:", e);
      }
    }
  }
}
