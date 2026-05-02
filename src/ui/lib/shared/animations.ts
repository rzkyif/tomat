/**
 * Transition factories and timing helpers for the app's UI animations.
 * All factories honour the two Appearance settings:
 *   - `appearance.animationsEnabled` (master switch; duration becomes 0 when off)
 *   - `appearance.animationSpeedMultiplier` (percent; higher = faster)
 */

import { settingsState } from "$lib/state";
import type { Alignment } from "$lib/shared/types";

export const BASE_MS = 200;

// cubic-bezier(0.4, 0, 0.2, 1) — material "standard" easing.
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

export function messageEnter(
  node: Element,
  { alignment, msgId }: { alignment: Alignment; msgId?: string },
) {
  if (msgId) {
    if (messagesSeen.has(msgId)) return { duration: 0 };
    messagesSeen.add(msgId);
  }
  if (!messageAnimationsReady) return { duration: 0 };

  const height = (node as HTMLElement).offsetHeight;
  const duration = getDuration(BASE_MS);
  if (!duration) return { duration: 0 };

  return {
    duration,
    css: (t: number) => {
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
      return `max-height: ${h}px; overflow: hidden; opacity: ${slideProgress}; transform: ${transform};`;
    },
  };
}

type SlideDirection = "in" | "out";

export function slidePanel(
  _node: Element,
  { alignment, direction }: { alignment: Alignment; direction: SlideDirection },
) {
  const duration = getDuration(BASE_MS);
  if (!duration) return { duration: 0 };

  // Sequence: outgoing panel slides first, then incoming slides in.
  const delay = direction === "in" ? duration : 0;

  return {
    duration,
    delay,
    css: (t: number) => {
      const p = easeInOut(t);
      const travel = 100 * (1 - p);
      let transform: string;
      if (alignment === "left") transform = `translateX(${-travel}%)`;
      else if (alignment === "right") transform = `translateX(${travel}%)`;
      else if (direction === "in") transform = `translateY(${travel}%)`;
      else transform = `translateY(${-travel}%)`;
      return `opacity: ${p}; transform: ${transform};`;
    },
  };
}

/**
 * Pins the given panel element to its current viewport rect with
 * `position: fixed`. Call this BEFORE flipping the reactive state that
 * triggers the panel swap — otherwise the incoming panel has already mounted
 * by the time the outgoing's transition function fires, and the outgoing's
 * measured position reflects post-mount layout shifts, not the original spot
 * the user was looking at.
 *
 * NOTE: Requires no transformed / perspective / filtered ancestor (those
 * trap `position: fixed` inside that ancestor's coordinate space, which
 * causes the pinned element to move when the ancestor resizes/repositions).
 * In this app we keep the window-slide transform off of `main` while it's
 * in the visible "in" state so this precondition holds.
 */
export function pinPanelForOutro(el: HTMLElement | null | undefined) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.top = `${rect.top}px`;
  el.style.left = `${rect.left}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

/**
 * Slide + fade transition used when toggling between the normal scroll-spy
 * group view and search results. Convention from the previous group-switch
 * animation:
 *   "up"   — incoming panel slides in from above, outgoing falls down
 *   "down" — incoming panel slides in from below, outgoing rises up
 * Search mode lives "above" the group list (its index is -1), so entering
 * search uses direction "up" and exiting uses direction "down".
 */
export function searchSlide(
  _node: Element,
  { direction, phase }: { direction: "up" | "down"; phase: "in" | "out" },
) {
  const duration = getDuration(BASE_MS);
  if (!duration) return { duration: 0 };

  const sign =
    (direction === "up" && phase === "in") || (direction === "down" && phase === "out") ? -1 : 1;

  return {
    duration,
    css: (t: number) => {
      const p = easeInOut(t);
      const travel = 100 * (1 - p) * sign;
      return `opacity: ${p}; transform: translateY(${travel}%);`;
    },
  };
}

export function expand(node: Element) {
  const duration = getDuration(BASE_MS);
  if (!duration) return { duration: 0 };

  const htmlNode = node as HTMLElement;

  // Uses `tick` (per-frame JS) instead of `css` (pre-baked keyframes) so the
  // target height tracks scrollHeight as it grows. Necessary for content that
  // renders asynchronously — e.g., MessageMarkdown in ReasoningTrace shows a
  // spinner first and only fills in the real HTML after `marked` + DOMPurify
  // complete. A pre-baked keyframe would animate to the spinner's height and
  // then the element would snap to full size when CSS clears at t=1.
  return {
    duration,
    tick: (t: number) => {
      if (t >= 1) {
        htmlNode.style.maxHeight = "";
        htmlNode.style.overflow = "";
        htmlNode.style.opacity = "";
      } else {
        const p = easeInOut(t);
        const height = htmlNode.scrollHeight;
        htmlNode.style.maxHeight = `${height * p}px`;
        htmlNode.style.overflow = "hidden";
        htmlNode.style.opacity = `${p}`;
      }
    },
  };
}
