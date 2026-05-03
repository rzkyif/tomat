<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Alignment } from "$lib/shared/types";

  let {
    selectedAlignment,
    size = "large",
    bgClass = "bg-default-300",
    extraClass = "",
    active = false,
    pulse = false,
    borderColorClass = "",
    neighborLeft = false,
    neighborRight = false,
    progress,
    progressFillBgClass = "bg-default-800",
    onclick,
    oncontextmenu,
    children,
  } = $props<{
    selectedAlignment: Alignment;
    /** "large" = roomy (px-5 py-4), used for primary message content.
     *  "small" = compact (px-3 py-2 + min-h-8), used for header-only / loading
     *  bubbles where the body is just an Expandable header or a spinner.
     *  Small bubbles enforce a uniform 2rem floor so a header-only bubble,
     *  a loading spinner bubble, and a bubble showing progress all share the
     *  same vertical extent in a stack row. */
    size?: "small" | "large";
    bgClass?: string;
    extraClass?: string;
    active?: boolean;
    pulse?: boolean;
    borderColorClass?: string;
    /** Visual-left side has another bubble in the same stack row; collapse
     *  the left-side rounding to `md` to signal adjacency. Composes with the
     *  alignment override (left-aligned bubbles already get `rounded-l-md`). */
    neighborLeft?: boolean;
    /** Visual-right side has another bubble in the same stack row. */
    neighborRight?: boolean;
    /** Progress visualisation rendered AS the bubble background. The fill
     *  occupies only the top header zone (h-8) so an expanded body underneath
     *  stays unaffected. `undefined` = no progress; `null` = indeterminate
     *  sweeping bar; number = percent (0..100). When set, content is rendered
     *  twice: the top copy is `filter: invert()`-ed and clipped to the fill
     *  rect so text and other UI elements over the bar read inverted. */
    progress?: number | null;
    /** Override for the determinate/indeterminate fill colour. Defaults to
     *  `bg-default-800` to pair with the default `bg-default-300` track. */
    progressFillBgClass?: string;
    onclick?: (e: MouseEvent) => void;
    oncontextmenu?: (e: MouseEvent) => void;
    children: Snippet;
  }>();

  let paddingClass = $derived(size === "small" ? "px-3 py-2" : "px-5 py-4");
  let minHClass = $derived(size === "small" ? "min-h-8" : "");
  let hasProgress = $derived(progress !== undefined);
  let percent = $derived(
    typeof progress === "number" ? Math.max(0, Math.min(100, progress)) : null,
  );
  // Right-aligned bubbles fill the progress bar from right to left so the
  // motion mirrors the bubble's anchor edge. The determinate fill anchors on
  // `right-0` instead of `left-0`; the indeterminate sweep and the
  // inverted-layer clip-path use mirrored keyframes / inset values.
  let isRight = $derived(selectedAlignment === "right");
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  {onclick}
  {oncontextmenu}
  role={onclick ? "presentation" : undefined}
  class="{bgClass} {minHClass} relative overflow-hidden rounded-2xl w-fit max-w-[calc(100vw-5rem)] break-words transition-all duration-100 border-solid pointer-events-auto {borderColorClass}"
  class:mr-auto={selectedAlignment === "left"}
  class:rounded-l-md={selectedAlignment === "left" || neighborLeft}
  class:border-l-8={selectedAlignment === "left" && active}
  class:border-l-0={selectedAlignment === "left" && !active}
  class:ml-auto={selectedAlignment === "right"}
  class:rounded-r-md={selectedAlignment === "right" || neighborRight}
  class:border-r-8={selectedAlignment === "right" && active}
  class:border-r-0={selectedAlignment === "right" && !active}
  class:mx-auto={selectedAlignment === "center"}
  class:border-b-8={selectedAlignment === "center" && active}
  class:border-b-0={selectedAlignment === "center" && !active}
  class:bubble-border-pulse={active && pulse}
>
  {#if hasProgress}
    {#if percent === null}
      <div
        class="absolute top-0 h-8 {progressFillBgClass}"
        class:left-0={!isRight}
        class:right-0={isRight}
        class:bubble-progress-indet={!isRight}
        class:bubble-progress-indet-rtl={isRight}
      ></div>
    {:else}
      <div
        class="absolute top-0 h-8 {progressFillBgClass} transition-all"
        class:left-0={!isRight}
        class:right-0={isRight}
        style="width: {percent}%"
      ></div>
    {/if}
  {/if}
  <div class="relative z-10 {paddingClass} {extraClass}">
    {@render children()}
  </div>
  {#if hasProgress}
    <!-- Inverted layer: same content rendered atop the fill, clipped to the
         filled rect. `filter: invert(1) hue-rotate(180deg)` flips all colours
         (text, icons, inline-pill bg/fg) to a perceptually-inverted version
         in one shot, no need to thread invert-color props through every
         descendant. The clip-path bottom inset keeps the inversion confined
         to the top h-8 header zone so an expanded body below renders
         normally. Children are rendered twice; Svelte's bind:expanded on the
         shared parent state keeps both Expandable instances in lockstep, and
         pointer-events:none on this layer routes all clicks to the lower
         (un-filtered) copy. -->
    <div
      class="bubble-progress-invert absolute inset-0 z-20 {paddingClass} {extraClass}"
      class:bubble-progress-invert-indet={percent === null && !isRight}
      class:bubble-progress-invert-indet-rtl={percent === null && isRight}
      style:clip-path={percent === null
        ? undefined
        : isRight
          ? `inset(0 0 calc(100% - 2rem) calc(100% - ${percent}%))`
          : `inset(0 calc(100% - ${percent}%) calc(100% - 2rem) 0)`}
      aria-hidden="true"
    >
      {@render children()}
    </div>
  {/if}
</div>

<style>
  /* Pulses the border color between its current value and transparent. With
     the default `background-clip: border-box`, the bubble's own bg paints
     under the border area, so the transparent half reveals the bg color,
     producing a pulse between `border-<hue>-400` and `bg-<hue>-300` with no
     extra color plumbing required. */
  .bubble-border-pulse {
    animation: bubble-border-pulse 0.5s ease-in-out infinite alternate;
  }
  @keyframes bubble-border-pulse {
    to {
      border-color: transparent;
    }
  }

  .bubble-progress-invert {
    filter: invert(1) hue-rotate(180deg);
    pointer-events: none;
  }

  /* Indeterminate fill: bar sweeps left → right, widening at the midpoint
     and collapsing at each end. Continuous motion via complementary
     per-keyframe easing. `ease-in` 0%→50% accelerates into the midpoint,
     `ease-out` 50%→100% decelerates out of it. */
  .bubble-progress-indet {
    animation: bubble-progress-indet 1.6s linear infinite;
    width: 0%;
    will-change: left, width;
  }
  @keyframes bubble-progress-indet {
    0% {
      left: 0%;
      width: 0%;
      animation-timing-function: ease-in;
    }
    50% {
      left: 25%;
      width: 50%;
      animation-timing-function: ease-out;
    }
    100% {
      left: 100%;
      width: 0%;
    }
  }
  /* Inversion clip tracks the indeterminate fill exactly: same duration,
     timing, and per-keyframe easing, so the inverted content always
     coincides with the moving bar. */
  .bubble-progress-invert-indet {
    animation: bubble-progress-invert-indet 1.6s linear infinite;
  }
  @keyframes bubble-progress-invert-indet {
    0% {
      clip-path: inset(0 100% calc(100% - 2rem) 0);
      animation-timing-function: ease-in;
    }
    50% {
      clip-path: inset(0 25% calc(100% - 2rem) 25%);
      animation-timing-function: ease-out;
    }
    100% {
      clip-path: inset(0 0 calc(100% - 2rem) 100%);
    }
  }

  /* Right-to-left mirror of the indeterminate sweep: bar enters from the
     right edge, widens through the midpoint, and collapses at the left.
     Anchors on `right` instead of `left` so the right-aligned bubble's
     progress motion mirrors its anchor edge. */
  .bubble-progress-indet-rtl {
    animation: bubble-progress-indet-rtl 1.6s linear infinite;
    width: 0%;
    will-change: right, width;
  }
  @keyframes bubble-progress-indet-rtl {
    0% {
      right: 0%;
      width: 0%;
      animation-timing-function: ease-in;
    }
    50% {
      right: 25%;
      width: 50%;
      animation-timing-function: ease-out;
    }
    100% {
      right: 100%;
      width: 0%;
    }
  }
  .bubble-progress-invert-indet-rtl {
    animation: bubble-progress-invert-indet-rtl 1.6s linear infinite;
  }
  @keyframes bubble-progress-invert-indet-rtl {
    0% {
      clip-path: inset(0 0 calc(100% - 2rem) 100%);
      animation-timing-function: ease-in;
    }
    50% {
      clip-path: inset(0 25% calc(100% - 2rem) 25%);
      animation-timing-function: ease-out;
    }
    100% {
      clip-path: inset(0 100% calc(100% - 2rem) 0);
    }
  }
</style>
