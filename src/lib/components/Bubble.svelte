<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Alignment } from "$lib/shared/types";

  let {
    selectedAlignment,
    paddingClass = "px-5 py-4",
    bgClass = "bg-default-300",
    extraClass = "",
    onclick,
    children,
  } = $props<{
    selectedAlignment: Alignment;
    paddingClass?: string;
    bgClass?: string;
    extraClass?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
  }>();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  {onclick}
  role={onclick ? "presentation" : undefined}
  class="{bgClass} {paddingClass} rounded-2xl w-fit break-words {extraClass}"
  class:mr-auto={selectedAlignment === "left"}
  class:rounded-l-md={selectedAlignment === "left"}
  class:ml-auto={selectedAlignment === "right"}
  class:rounded-r-md={selectedAlignment === "right"}
  class:mx-auto={selectedAlignment === "center"}
>
  {@render children()}
</div>
