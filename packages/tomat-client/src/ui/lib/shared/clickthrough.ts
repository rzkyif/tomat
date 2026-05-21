// deno-lint-ignore-file tomat/no-tauri-import -- TODO: expose
//   `windowing.setIgnoreCursorEvents` and `windowing.cursorPosition` on the
//   Platform interface so this file can stop importing @tauri-apps directly.
//   Tracked as part of the click-through refactor; until then this is the
//   only call site for Tauri's cursor-poll API.
/**
 * Makes the overlay window click-through except where there's actual app
 * content. The window passes mouse clicks through to whatever is behind it
 * unless the cursor is hovering over a real UI element.
 */

import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();

let ignoring = true;
let paused = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let contentEl: HTMLElement | null = null;

function setIgnored(value: boolean) {
  ignoring = value;
  document.documentElement.dataset.cursorIgnored = value ? "true" : "false";
}

function isOverContent(x: number, y: number): boolean {
  if (!contentEl) return false;
  const el = document.elementFromPoint(x, y);
  return !!el && el !== contentEl && contentEl.contains(el);
}

function startPolling() {
  if (pollInterval || paused) return;
  pollInterval = setInterval(checkCursor, 40);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function switchToCapture() {
  await win.setIgnoreCursorEvents(false);
  setIgnored(false);
  if (document.hasFocus()) {
    // Window is focused - use mousemove for responsive exit detection
    stopPolling();
    document.addEventListener("mousemove", onMouseMove);
    window.addEventListener("blur", onBlurWhileCapturing, { once: true });
  }
  // If not focused, keep polling so we can detect cursor leaving
}

async function switchToIgnore() {
  document.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("blur", onBlurWhileCapturing);
  try {
    await win.setIgnoreCursorEvents(true);
  } catch {
    // ignore
  }
  setIgnored(true);
  startPolling();
}

async function checkCursor() {
  if (!contentEl || paused) return;
  try {
    const [cursor, winPos] = await Promise.all([cursorPosition(), win.outerPosition()]);
    const sf = window.devicePixelRatio || 1;
    const relX = (cursor.x - winPos.x) / sf;
    const relY = (cursor.y - winPos.y) / sf;

    const over = isOverContent(relX, relY);

    if (over && ignoring) {
      await switchToCapture();
    } else if (!over && !ignoring) {
      await switchToIgnore();
    }
  } catch {
    // window may be hidden or unavailable
  }
}

async function onMouseMove(e: MouseEvent) {
  if (paused) return;
  if (!isOverContent(e.clientX, e.clientY)) {
    await switchToIgnore();
  }
}

function onBlurWhileCapturing() {
  // Window lost focus while in capture mode - fall back to polling
  // so we can still detect cursor leaving without mousemove events
  document.removeEventListener("mousemove", onMouseMove);
  startPolling();
}

export async function startClickThrough(el: HTMLElement) {
  contentEl = el;
  paused = false;
  setIgnored(true);
  await win.setIgnoreCursorEvents(true);
  startPolling();
}

export async function pauseClickThrough() {
  paused = true;
  stopPolling();
  document.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("blur", onBlurWhileCapturing);
}

export async function resumeClickThrough() {
  if (!contentEl) return;
  paused = false;
  setIgnored(true);
  try {
    await win.setIgnoreCursorEvents(true);
  } catch {
    // ignore
  }
  startPolling();
}

export function stopClickThrough() {
  stopPolling();
  document.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("blur", onBlurWhileCapturing);
  contentEl = null;
  paused = false;
}
