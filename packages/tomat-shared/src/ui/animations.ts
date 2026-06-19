// Animation timing constants shared by every tomat UI surface. The actual
// transition factories (which read the client's animation settings) stay in the
// client; what is shared is the canonical easing curve and base duration so the
// extracted components and the website animate on the same numbers. The client
// resolves a settings-aware duration through the UI context's
// `animationDurationMs`; the website (and any standalone render) uses BASE_MS.

/** cubic-bezier(0.4, 0, 0.2, 1): material "standard" easing. */
export const CSS_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/** Base transition length in milliseconds. */
export const BASE_MS = 267;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** cubic-bezier(0.4, 0, 0.2, 1) sampled as a JS easing for rAF-driven motion. */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export interface ExpandHandle {
  cancel(): void;
}

/**
 * Drive a per-frame max-height + opacity expand/collapse on `el`, shared so the
 * client (`Expand`/`Expandable`) and the website render the same motion. Per
 * frame (not a CSS transition to a baked height) so the target tracks
 * `scrollHeight` as async content fills in (e.g. markdown that renders a spinner
 * first). `durationMs` is resolved by the caller (client: settings-aware via the
 * UI context; website: `BASE_MS`); `<= 0` snaps to the end state.
 *   - "open":  t 0->1, ends with styles cleared (natural height)
 *   - "close": t 1->0, ends fully hidden
 */
export function runExpand(
  el: HTMLElement,
  direction: "open" | "close",
  durationMs: number,
  onComplete?: () => void,
): ExpandHandle {
  if (durationMs <= 0) {
    if (direction === "open") {
      el.style.maxHeight = "";
      el.style.overflow = "";
      el.style.opacity = "";
    } else {
      el.style.maxHeight = "0";
      el.style.overflow = "hidden";
      el.style.opacity = "0";
    }
    onComplete?.();
    return { cancel: () => {} };
  }

  let cancelled = false;
  let rafId = 0;
  const startTime = performance.now();

  const frame = (now: number) => {
    if (cancelled) return;
    const elapsed = (now - startTime) / durationMs;
    const t = direction === "open" ? Math.min(1, elapsed) : Math.max(0, 1 - elapsed);
    const done = (direction === "open" && t >= 1) || (direction === "close" && t <= 0);
    if (done) {
      if (direction === "open") {
        el.style.maxHeight = "";
        el.style.overflow = "";
        el.style.opacity = "";
      } else {
        el.style.maxHeight = "0";
        el.style.overflow = "hidden";
        el.style.opacity = "0";
      }
      onComplete?.();
      return;
    }
    const p = easeInOut(t);
    const height = el.scrollHeight;
    el.style.maxHeight = `${height * p}px`;
    el.style.overflow = "hidden";
    el.style.opacity = `${p}`;
    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);
  return {
    cancel() {
      cancelled = true;
      cancelAnimationFrame(rafId);
    },
  };
}

/**
 * The settings panel's content-layer slide-swap, shared so the client (settings
 * groups + tabs) and the website showcase produce byte-identical motion. Phase 1
 * slides the current content out by `outSign` along `axis`; `swap` then mutates
 * the content while it sits offscreen on the opposite side; phase 3 slides the
 * new content back to rest. `durationMs` is the per-phase length the caller has
 * already resolved (client: settings-aware `getDuration()`; website: `BASE_MS`).
 * With `durationMs <= 0` or no element, `swap` runs synchronously.
 *
 *   axis "y" + outSign 1  => current leaves upward, new enters from below.
 *   axis "x" + outSign -1 => current leaves leftward, new enters from the right.
 *
 * `swap` may be async (e.g. the client awaits Svelte's `tick()` so the new DOM
 * exists before it is parked offscreen).
 */
export async function slideSwap(
  el: HTMLElement | undefined,
  opts: {
    axis: "x" | "y";
    outSign: 1 | -1;
    durationMs: number;
    swap: () => void | Promise<void>;
  },
): Promise<void> {
  const { axis, outSign, durationMs, swap } = opts;
  if (!el || durationMs <= 0) {
    await swap();
    return;
  }
  const fn = axis === "y" ? "translateY" : "translateX";
  const trans = `transform ${durationMs}ms ${CSS_EASING}`;

  el.style.transition = trans;
  el.style.transform = `${fn}(${100 * outSign}%)`;
  await wait(durationMs);

  await swap();
  el.style.transition = "none";
  el.style.transform = `${fn}(${100 * -outSign}%)`;
  void el.offsetHeight;

  el.style.transition = trans;
  el.style.transform = "";
  await wait(durationMs);
  el.style.transition = "";
}

// Sidebar labels share one expansion SPEED, not one duration: the transition
// time scales with each label's pixel width, so every row sweeps open (and
// closed) at the same px/ms regardless of text length. `LABEL_REF_WIDTH` is the
// width that animates in exactly `BASE_MS`; `LABEL_MIN_MS` floors near-empty
// labels above a sub-frame duration. No upper clamp (that made short labels lag).
const LABEL_REF_WIDTH = 96;
const LABEL_MIN_MS = 50;

/** The natural (pre-speed-policy) collapse duration for a label `width` px wide. */
export function labelCollapseBaseMs(width: number): number {
  return Math.max(LABEL_MIN_MS, (Math.max(0, width) / LABEL_REF_WIDTH) * BASE_MS);
}

/**
 * Animate a label's horizontal slide between visible (natural width, opacity 1)
 * and collapsed (width 0, opacity 0). Width is measured live via `scrollWidth`
 * so dynamic content ("Downloads" -> "Downloading...") animates correctly.
 * `resolveDuration` turns the natural width-scaled ms into the app's effective
 * duration (client applies the animation settings; website returns it as-is, or
 * 0 to skip). Returning 0 collapses/expands instantly.
 */
export function collapseLabel(
  el: HTMLElement,
  collapsed: boolean,
  resolveDuration: (baseMs: number) => number,
): void {
  if (collapsed) {
    const w = el.scrollWidth || el.getBoundingClientRect().width;
    const dur = resolveDuration(labelCollapseBaseMs(w));
    if (dur <= 0) {
      el.style.transition = "";
      el.style.width = "0px";
      el.style.opacity = "0";
      return;
    }
    const trans = `width ${dur}ms ${CSS_EASING}, opacity ${dur}ms ${CSS_EASING}`;
    el.style.transition = "none";
    el.style.width = `${w}px`;
    el.style.opacity = "1";
    void el.offsetHeight;
    el.style.transition = trans;
    el.style.width = "0px";
    el.style.opacity = "0";
  } else {
    el.style.transition = "none";
    el.style.width = "auto";
    el.style.opacity = "1";
    const w = el.scrollWidth;
    const dur = resolveDuration(labelCollapseBaseMs(w));
    if (dur <= 0) {
      el.style.width = "";
      return;
    }
    const trans = `width ${dur}ms ${CSS_EASING}, opacity ${dur}ms ${CSS_EASING}`;
    el.style.width = "0px";
    el.style.opacity = "0";
    void el.offsetHeight;
    el.style.transition = trans;
    el.style.width = `${w}px`;
    el.style.opacity = "1";
    // Drop the explicit width once the transition finishes so the span can
    // resize naturally if its content later changes.
    setTimeout(() => {
      if (el.style.width === `${w}px`) {
        el.style.transition = "";
        el.style.width = "";
      }
    }, dur);
  }
}
