<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { applyLabelCollapse } from "$lib/appearance/animations";

  let {
    collapsed,
    class: className = "",
    children,
  }: {
    collapsed: boolean;
    class?: string;
    children: Snippet;
  } = $props();

  let el: HTMLElement | undefined = $state();
  let firstRun = true;

  // Inline style on first paint matches the initial collapsed state so the
  // label doesn't flash at full width before $effect takes over. `untrack`
  // ensures Svelte doesn't re-render the attribute when `collapsed` flips
  // (subsequent updates flow through $effect → el.style.* directly).
  const initialStyle = untrack(() =>
    collapsed ? "width: 0; opacity: 0;" : "",
  );

  $effect(() => {
    const c = collapsed;
    if (!el) return;
    applyLabelCollapse(el, c, firstRun);
    firstRun = false;
  });
</script>

<span
  bind:this={el}
  class="inline-block overflow-hidden whitespace-nowrap {className}"
  style={initialStyle}
>
  {@render children()}
</span>
