<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { runMessageEnter } from "$lib/appearance/animations";
  import type { Alignment } from "$lib/util/types";

  let {
    alignment,
    msgId,
    delayMs = 0,
    class: className = "",
    children,
  }: {
    alignment: Alignment;
    msgId?: string;
    /** Hold the entry animation for this long; see runMessageEnter. */
    delayMs?: number;
    class?: string;
    children: Snippet;
  } = $props();

  let el: HTMLElement | undefined = $state();

  onMount(() => {
    if (el) runMessageEnter(el, alignment, msgId, delayMs);
  });
</script>

<!-- No permanent will-change here: a persistent will-change-transform makes
     every message row its own stacking context, which lets one bubble's drop
     shadow paint over neighboring bubbles. runMessageEnter sets the hint
     inline for the duration of the entry animation only. -->
<div bind:this={el} class={className}>
  {@render children()}
</div>
