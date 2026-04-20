<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Alignment } from "$lib/shared/types";

  let {
    selectedAlignment,
    paddingClass = "px-5 py-4",
    bgClass = "bg-default-300",
    extraClass = "",
    active = false,
    pulse = false,
    borderColorClass = "",
    onclick,
    oncontextmenu,
    children,
  } = $props<{
    selectedAlignment: Alignment;
    paddingClass?: string;
    bgClass?: string;
    extraClass?: string;
    active?: boolean;
    pulse?: boolean;
    borderColorClass?: string;
    onclick?: (e: MouseEvent) => void;
    oncontextmenu?: (e: MouseEvent) => void;
    children: Snippet;
  }>();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  {onclick}
  {oncontextmenu}
  role={onclick ? "presentation" : undefined}
  class="{bgClass} {paddingClass} rounded-2xl w-fit break-words transition-all duration-100 border-solid {borderColorClass} {extraClass}"
  class:mr-auto={selectedAlignment === "left"}
  class:rounded-l-md={selectedAlignment === "left"}
  class:border-l-8={selectedAlignment === "left" && active}
  class:border-l-0={selectedAlignment === "left" && !active}
  class:ml-auto={selectedAlignment === "right"}
  class:rounded-r-md={selectedAlignment === "right"}
  class:border-r-8={selectedAlignment === "right" && active}
  class:border-r-0={selectedAlignment === "right" && !active}
  class:mx-auto={selectedAlignment === "center"}
  class:border-b-8={selectedAlignment === "center" && active}
  class:border-b-0={selectedAlignment === "center" && !active}
  class:bubble-border-pulse={active && pulse}
>
  {@render children()}
</div>

<style>
  /* Pulses the border color between its current value and transparent. With
     the default `background-clip: border-box`, the bubble's own bg paints
     under the border area, so the transparent half reveals the bg color —
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
</style>
