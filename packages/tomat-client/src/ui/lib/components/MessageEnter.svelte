<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { runMessageEnter } from "$lib/shared/animations";
  import { settingsState } from "$lib/state";
  import type { Alignment } from "$lib/shared/types";

  let {
    alignment,
    msgId,
    class: className = "",
    children,
  }: {
    alignment: Alignment;
    msgId?: string;
    class?: string;
    children: Snippet;
  } = $props();

  let el: HTMLElement | undefined = $state();

  const animationsEnabled = $derived(
    !!settingsState.currentSettings["appearance.animationsEnabled"],
  );

  onMount(() => {
    if (el) runMessageEnter(el, alignment, msgId);
  });
</script>

<div
  bind:this={el}
  class={className}
  class:will-change-transform={animationsEnabled}
>
  {@render children()}
</div>
