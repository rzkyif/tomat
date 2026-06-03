/**
 * Transition factories and timing helpers for the app's UI animations.
 * All factories honour the two Appearance settings:
 *   - `appearance.animationsEnabled` (master switch; duration becomes 0 when off)
 *   - `appearance.animationSpeedMultiplier` (percent; higher = faster)
 */

import { settingsState } from "$lib/state";
import type { Alignment } from "$lib/shared/types";

export const BASE_MS = 267;

export const CSS_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

// cubic-bezier(0.4, 0, 0.2, 1): material "standard" easing.
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function getDuration(ms: number = BASE_MS): number {
  if (!settingsState.currentSettings["appearance.animationsEnabled"]) return 0;
  const mult =
    (settingsState.currentSettings["appearance.animationSpeedMultiplier"] as number) ?? 100;
  if (!mult || mult <= 0) return ms;
  return (ms * 100) / mult;
}

// Gate used by +page.svelte to suppress message entry animations during the
// initial session-restore burst. Without this, loading a 50-message session
// would kick off 50 simultaneous entry animations.
let messageAnimationsReady = false;
// Stable msgIds we've already mounted. Prevents the slide-in from replaying
// on remount (e.g. load-more-history reshuffles wrappers, or stack regrouping
// moves a bubble under a new parent). Recorded even while gated so the
// post-gate state already knows about every mounted message.
const messagesSeen = new Set<string>();
export function enableMessageAnimations() {
  messageAnimationsReady = true;
}

/**
 * Imperatively run the per-message entry animation: a two-phase rAF where
 * phase A grows max-height (so neighbours don't jump) and phase B slides +
 * fades the bubble in from the alignment-appropriate edge.
 *   - `msgId` is used to dedupe replays: a bubble that's already been
 *     animated stays animated even if its parent reshuffles (e.g. when
 *     MessageStackGroup regroups).
 * No outro: there is no symmetric exit animation, removals are instant.
 */
export function runMessageEnter(node: HTMLElement, alignment: Alignment, msgId?: string): void {
  if (msgId) {
    if (messagesSeen.has(msgId)) return;
    messagesSeen.add(msgId);
  }
  if (!messageAnimationsReady) return;

  const dur = getDuration(BASE_MS);
  if (dur <= 0) return;

  const height = node.offsetHeight;
  const startTime = performance.now();

  const setOffscreen = () => {
    node.style.maxHeight = "0";
    node.style.overflow = "hidden";
    node.style.opacity = "0";
    if (alignment === "left") node.style.transform = "translateX(-100%)";
    else if (alignment === "right") node.style.transform = "translateX(100%)";
    else node.style.transform = "translateY(100%)";
  };

  setOffscreen();
  void node.offsetHeight;

  const frame = (now: number) => {
    const t = Math.min(1, (now - startTime) / dur);
    if (t >= 1) {
      node.style.maxHeight = "";
      node.style.overflow = "";
      node.style.opacity = "";
      node.style.transform = "";
      return;
    }
    const phaseA = Math.min(1, t * 2);
    const phaseB = Math.max(0, (t - 0.5) * 2);
    const heightProgress = easeInOut(phaseA);
    const slideProgress = easeInOut(phaseB);
    const h = height * heightProgress;
    const travel = 100 * (1 - slideProgress);
    let transform: string;
    if (alignment === "left") transform = `translateX(${-travel}%)`;
    else if (alignment === "right") transform = `translateX(${travel}%)`;
    else transform = `translateY(${travel}%)`;
    node.style.maxHeight = `${h}px`;
    node.style.overflow = "hidden";
    node.style.opacity = `${slideProgress}`;
    node.style.transform = transform;
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

/**
 * Imperatively animate a label's horizontal slide between visible (natural
 * width, opacity 1) and collapsed (width 0, opacity 0). Same shape as the
 * panel slide in +page.svelte: set transition, then assign the target style.
 *   - `instant`: skip the animation (first mount, or animations disabled).
 * Width is measured via `scrollWidth` while temporarily releasing the
 * explicit width; this lets the same span handle dynamic content (e.g.
 * "Downloads" → "Downloading…") without caching a stale natural width.
 */
// Sidebar labels share one expansion SPEED, not one duration: the transition
// time scales with each label's pixel width, so every row sweeps open (and
// closed) at the same px/ms regardless of text length. A single fixed duration
// makes wide rows look faster than narrow ones, which reads as choppy and
// inconsistent. No upper clamp (that is what made short labels lag); the small
// floor only guards against a sub-frame duration for a near-empty label.
const LABEL_REF_WIDTH = 96; // px that animate in exactly BASE_MS at the shared speed
const LABEL_MIN_MS = 50;

function labelCollapseDuration(width: number, instant: boolean): number {
  if (instant) return 0;
  const base = Math.max(LABEL_MIN_MS, (Math.max(0, width) / LABEL_REF_WIDTH) * BASE_MS);
  return getDuration(base);
}

export function applyLabelCollapse(el: HTMLElement, collapsed: boolean, instant: boolean): void {
  if (collapsed) {
    const w = el.scrollWidth || el.getBoundingClientRect().width;
    const dur = labelCollapseDuration(w, instant);
    if (dur === 0) {
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
    const dur = labelCollapseDuration(w, instant);
    if (dur === 0) {
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

export interface ExpandHandle {
  cancel(): void;
}

/**
 * Drive a per-frame max-height + opacity animation on `el`. Used by
 * <Expand>. Per-frame (rather than CSS transition to a baked-in scrollHeight)
 * so the target height tracks scrollHeight as it grows. Necessary for
 * content that renders asynchronously, e.g. MessageMarkdown in ReasoningTrace
 * shows a spinner first and only fills in the real HTML after `marked` +
 * DOMPurify complete.
 *   - direction "open":  t goes 0→1, ends with styles cleared (natural)
 *   - direction "close": t goes 1→0, ends fully hidden
 * `onComplete` fires after the target state is reached. The returned handle
 * lets callers cancel an in-flight animation.
 */
export function runExpand(
  el: HTMLElement,
  direction: "open" | "close",
  onComplete?: () => void,
): ExpandHandle {
  const dur = getDuration();
  if (dur <= 0) {
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
    const elapsed = (now - startTime) / dur;
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
