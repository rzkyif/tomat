<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import { runExpand, type ExpandHandle } from "$lib/shared/animations";

  let {
    open,
    /** When true, animate the open transition on initial mount if `open`
     *  starts true. Mirrors the `in:expand|global` semantics on Expandable
     *  (the body's open animation runs even when its parent remounts). */
    animateOnMount = false,
    class: className = "",
    children,
  }: {
    open: boolean;
    animateOnMount?: boolean;
    class?: string;
    children: Snippet;
  } = $props();

  let el: HTMLElement | undefined = $state();
  let mounted = $state(untrack(() => open));
  let initialized = false;
  // Set just before the wrapper mounts to tell the {@attach} hook to apply
  // hidden styles synchronously before the first paint.
  let pendingHide = untrack(() => open && animateOnMount);
  let active: ExpandHandle | null = null;

  function attach(node: HTMLElement) {
    if (pendingHide) {
      node.style.maxHeight = "0";
      node.style.overflow = "hidden";
      node.style.opacity = "0";
      pendingHide = false;
    }
    return () => {};
  }

  $effect(() => {
    const isOpen = open;

    if (!initialized) {
      initialized = true;
      if (isOpen && animateOnMount && el) {
        active?.cancel();
        active = runExpand(el, "open");
      }
      return;
    }

    if (isOpen && !mounted) {
      pendingHide = true;
      mounted = true;
      void tick().then(() => {
        if (!el) return;
        active?.cancel();
        active = runExpand(el, "open");
      });
    } else if (!isOpen && mounted) {
      if (!el) {
        mounted = false;
        return;
      }
      active?.cancel();
      active = runExpand(el, "close", () => {
        mounted = false;
        active = null;
      });
    }
  });
</script>

{#if mounted}
  <div bind:this={el} class={className} {@attach attach}>
    {@render children()}
  </div>
{/if}
