<script lang="ts">
  import type { Snippet } from "svelte";

  type Placement = "top" | "bottom" | "auto";

  let {
    open,
    anchor,
    onclose,
    placement = "auto",
    margin = 8,
    dismissOnEsc = true,
    ariaLabel,
    class: extraClass = "",
    children,
  }: {
    open: boolean;
    anchor: HTMLElement | null | undefined;
    onclose: () => void;
    placement?: Placement;
    margin?: number;
    dismissOnEsc?: boolean;
    ariaLabel?: string;
    class?: string;
    children: Snippet;
  } = $props();

  let backdropEl: HTMLDivElement | undefined = $state();
  let popupEl: HTMLDivElement | undefined = $state();
  // Hide the popup until the real height has been measured and the position
  // computed. Without this guard it briefly flashes at the backdrop origin
  // before snapping into place.
  let popupStyle = $state("visibility: hidden;");

  function computeStyle() {
    if (!backdropEl || !popupEl || !anchor) return;
    const aRect = anchor.getBoundingClientRect();
    const b = backdropEl.getBoundingClientRect();
    // Measure actual popup height — content varies and a hardcoded estimate
    // routinely under-counted, causing "above" placement to clip when the
    // real popup couldn't fit.
    const ph = popupEl.offsetHeight;
    const cx = aRect.left - b.left + aRect.width / 2;
    const spaceAbove = aRect.top - b.top;
    const spaceBelow = b.bottom - aRect.bottom;

    let placeAbove: boolean;
    if (placement === "top") placeAbove = true;
    else if (placement === "bottom") placeAbove = false;
    else if (spaceAbove >= ph + margin) placeAbove = true;
    else if (spaceBelow >= ph + margin) placeAbove = false;
    else placeAbove = spaceAbove > spaceBelow;

    if (placeAbove) {
      const top = aRect.top - b.top - margin;
      popupStyle =
        `left: ${cx}px; top: ${top}px; transform: translate(-50%, -100%); visibility: visible;`;
    } else {
      const top = aRect.bottom - b.top + margin;
      popupStyle =
        `left: ${cx}px; top: ${top}px; transform: translate(-50%, 0); visibility: visible;`;
    }
  }

  $effect(() => {
    if (open && anchor) {
      popupStyle = "visibility: hidden;";
      // Double rAF: first frame lets Svelte mount the popup so layout can
      // run, second frame guarantees offsetHeight reflects the laid-out size.
      requestAnimationFrame(() => requestAnimationFrame(() => computeStyle()));
    }
  });

  $effect(() => {
    if (!open || !dismissOnEsc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:window onresize={computeStyle} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="absolute inset-0 z-50 bg-black/20 backdrop-blur"
    onclick={onclose}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={popupEl}
      class="absolute bg-default-300 rounded-large p-5 flex flex-col gap-3 {extraClass}"
      style={popupStyle}
      role="dialog"
      tabindex="-1"
      aria-label={ariaLabel}
      onclick={(e) => e.stopPropagation()}
    >
      {@render children()}
    </div>
  </div>
{/if}
