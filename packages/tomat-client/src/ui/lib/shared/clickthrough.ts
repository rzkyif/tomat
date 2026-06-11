/**
 * Makes the overlay window click-through except where there's actual app
 * content. The window passes mouse clicks through to whatever is behind it
 * unless the cursor is hovering over a real UI element.
 */

import { platform } from "$lib/platform";
import { getLogger } from "$lib/shared/log";

const log = getLogger("clickthrough");

let ignoring = true;
let paused = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let contentEl: HTMLElement | null = null;
// checkCursor runs at 25 Hz; throttle its failure log so a persistent fault
// can't flood the dev console. Wall-clock ms of the last emitted skip log.
let lastSkipLogMs = 0;

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

// WebKit pushes an NSCursor only when the computed cursor differs from the
// one it last set. While the window ignores mouse events macOS reverts the
// visible cursor to the arrow, but WebKit (receiving no events) still caches
// the cursor of the element hovered before the gap. Re-entering an element
// that wants that same cursor (bubble -> gap -> bubble, both `pointer`)
// computes an unchanged value, so WebKit never re-asserts it and the arrow
// sticks. Forcing every element to `default` for a frame makes the next
// hover recompute a CHANGED value, which re-asserts the real cursor; since
// `default` is the arrow the OS is already showing, the override itself is
// invisible.
function forceCursorRefresh() {
  const root = document.documentElement;
  root.classList.add("cursor-refresh");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove("cursor-refresh"));
  });
}

async function switchToCapture() {
  await platform().cursor.setClickthrough(false);
  setIgnored(false);
  forceCursorRefresh();
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
    await platform().cursor.setClickthrough(true);
  } catch (e) {
    log.warn("setClickthrough(true) failed:", e);
  }
  setIgnored(true);
  startPolling();
}

async function checkCursor() {
  if (!contentEl || paused) return;
  try {
    const [cursor, winPos] = await Promise.all([
      platform().cursor.getPosition(),
      platform().windowing.outerPosition(),
    ]);
    const sf = window.devicePixelRatio || 1;
    const relX = (cursor.x - winPos.x) / sf;
    const relY = (cursor.y - winPos.y) / sf;

    const over = isOverContent(relX, relY);

    if (over && ignoring) {
      await switchToCapture();
    } else if (!over && !ignoring) {
      await switchToIgnore();
    }
  } catch (e) {
    // Window may be hidden or unavailable during a polling tick; common
    // during show/hide transitions, so log at debug volume - and throttle to
    // ~1/sec since this loop ticks 25 times a second.
    const now = Date.now();
    if (now - lastSkipLogMs > 1000) {
      lastSkipLogMs = now;
      log.debug("checkCursor skipped:", e);
    }
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
  await platform().cursor.setClickthrough(true);
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
    await platform().cursor.setClickthrough(true);
  } catch (e) {
    log.warn("resume setClickthrough(true) failed:", e);
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
