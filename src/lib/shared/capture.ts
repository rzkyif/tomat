/**
 * Take screenshots of the user's monitors. Lists available monitors and
 * captures one as a base64 PNG, briefly hiding the app window first so it
 * doesn't show up in the screenshot.
 */

import { invoke } from "@tauri-apps/api/core";

export interface CaptureMonitorInfo {
  id: string;
  name: string;
  isPrimary: boolean;
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
