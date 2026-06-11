/**
 * Keeps the frosted-bubble backdrop blur alive while the page is idle.
 *
 * WebKit re-samples what is behind the transparent window only when the page
 * commits a new frame: on a fully idle page the sampled backdrop goes stale
 * and the halo blur visibly drops out. A blinking text caret is empirically
 * enough to keep it alive, so this imitates that cadence: a 1x1 px
 * near-invisible element whose background toggles between two
 * near-identical colors, forcing one tiny paint + layer commit per tick.
 * Runs only while the document is visible; the cost is two 1-pixel paints
 * per second.
 */

const TICK_MS = 500;

let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let flip = false;
let visibilityListener: (() => void) | null = null;

function tick(): void {
  if (!el) return;
  flip = !flip;
  el.style.backgroundColor = flip ? "#000001" : "#000000";
}

function startTimer(): void {
  if (timer === null) timer = setInterval(tick, TICK_MS);
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function startBlurKeepalive(): void {
  if (el) return;
  el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;";
  document.body.appendChild(el);
  visibilityListener = () => {
    if (document.visibilityState === "visible") startTimer();
    else stopTimer();
  };
  document.addEventListener("visibilitychange", visibilityListener);
  if (document.visibilityState === "visible") startTimer();
}

export function stopBlurKeepalive(): void {
  stopTimer();
  if (visibilityListener) {
    document.removeEventListener("visibilitychange", visibilityListener);
    visibilityListener = null;
  }
  el?.remove();
  el = null;
}
