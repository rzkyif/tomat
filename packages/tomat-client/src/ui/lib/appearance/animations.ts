/**
 * Transition factories and timing helpers for the app's UI animations.
 * All factories honour the two Appearance settings:
 *   - `appearance.animationsEnabled` (master switch; duration becomes 0 when off)
 *   - `appearance.animationSpeedMultiplier` (percent; higher = faster)
 */

import { settingsState } from "$stores";
import type { Alignment } from "$lib/util/types";
import {
  BASE_MS,
  collapseLabel,
  type ExpandHandle,
  runExpand as runExpandShared,
} from "@tomat/shared/ui/animations";

export { BASE_MS, type ExpandHandle };

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

/** Whether the message's entry animation already ran (or was recorded while
 *  gated). Lets the transcript compute stagger delays for only the bubbles
 *  that are actually about to enter. */
export function hasMessageAnimated(msgId: string): boolean {
  return messagesSeen.has(msgId);
}

/**
 * Imperatively run the per-message entry animation: one eased rAF phase that
 * simultaneously grows max-height (so neighbours don't jump) and slides the
 * bubble in from the alignment-appropriate edge. No fade: the bubble is
 * fully opaque the whole way. For the duration the node is pushed to
 * z-index -1, so a bubble entering a stack row emerges from UNDER its
 * neighbors instead of sweeping over them.
 *   - `msgId` is used to dedupe replays: a bubble that's already been
 *     animated stays animated even if its parent reshuffles (e.g. when
 *     MessageStackGroup regroups).
 *   - `delayMs` holds the bubble offscreen (collapsed) before the motion
 *     starts. Used to stagger bubbles that mount in the same flush as
 *     another (the tool_filter created alongside its user message), so the
 *     entrances read sequentially instead of racing.
 * No outro: there is no symmetric exit animation, removals are instant.
 */
export function runMessageEnter(
  node: HTMLElement,
  alignment: Alignment,
  msgId?: string,
  delayMs = 0,
): void {
  if (msgId) {
    if (messagesSeen.has(msgId)) return;
    messagesSeen.add(msgId);
  }
  if (!messageAnimationsReady) return;

  const dur = getDuration(BASE_MS);
  if (dur <= 0) return;

  const height = node.offsetHeight;

  const setOffscreen = () => {
    // Scoped to the animation: left in place permanently, will-change makes
    // the row a stacking context, which lets one bubble's shadow paint over
    // its neighbors (see Bubble.svelte's shadow layering).
    node.style.willChange = "transform";
    // Below every settled sibling (bodies z-10, shadows z-0) while entering;
    // needs position since the node is a plain block, not a flex item.
    node.style.position = "relative";
    node.style.zIndex = "-1";
    node.style.maxHeight = "0";
    node.style.overflow = "hidden";
    if (alignment === "left") node.style.transform = "translateX(-100%)";
    else if (alignment === "right") node.style.transform = "translateX(100%)";
    else node.style.transform = "translateY(100%)";
  };

  setOffscreen();
  void node.offsetHeight;

  let startTime = 0;
  const frame = (now: number) => {
    if (startTime === 0) startTime = now;
    const t = Math.min(1, (now - startTime) / dur);
    if (t >= 1) {
      node.style.willChange = "";
      node.style.position = "";
      node.style.zIndex = "";
      node.style.maxHeight = "";
      node.style.overflow = "";
      node.style.transform = "";
      return;
    }
    const p = easeInOut(t);
    const travel = 100 * (1 - p);
    let transform: string;
    if (alignment === "left") transform = `translateX(${-travel}%)`;
    else if (alignment === "right") transform = `translateX(${travel}%)`;
    else transform = `translateY(${travel}%)`;
    node.style.maxHeight = `${height * p}px`;
    node.style.overflow = "hidden";
    node.style.transform = transform;
    requestAnimationFrame(frame);
  };

  if (delayMs > 0) setTimeout(() => requestAnimationFrame(frame), delayMs);
  else requestAnimationFrame(frame);
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
/**
 * Animate a sidebar label's collapse/expand. The width-scaled speed and the DOM
 * choreography live in the shared `collapseLabel`; here we only supply the app's
 * duration policy: `instant` (first mount / animations off) skips it, otherwise
 * the natural ms passes through `getDuration` (master switch + speed multiplier).
 */
export function applyLabelCollapse(el: HTMLElement, collapsed: boolean, instant: boolean): void {
  collapseLabel(el, collapsed, (baseMs) => (instant ? 0 : getDuration(baseMs)));
}

/**
 * Per-frame expand/collapse. The motion lives in the shared `runExpand`; here we
 * only resolve the app's settings-aware duration. Kept so existing client
 * callers (`$lib/appearance/animations`) need no import change.
 */
export function runExpand(
  el: HTMLElement,
  direction: "open" | "close",
  onComplete?: () => void,
): ExpandHandle {
  return runExpandShared(el, direction, getDuration(), onComplete);
}
