<script lang="ts">
  import type { Snippet } from "svelte";
  import { expand } from "$lib/shared/animations";
  import type { Alignment } from "$lib/shared/types";

  let {
    title,
    children,
    expanded = $bindable(false),
    disabled = false,
    alignment = "left",
    headerClass = "flex items-center gap-1 text-xs text-default-700 hover:cursor-pointer w-full",
  }: {
    title: Snippet;
    children: Snippet;
    /** Bindable open state. Parents own the source of truth so the bubble's
     *  expansion can be driven externally (e.g. tool-call auto-open on
     *  awaiting_user, or sharing into a global expansion map for chain-break
     *  computations). */
    expanded?: boolean;
    /** Disables the toggle button (used for empty-state gates like "no
     *  details to show"). */
    disabled?: boolean;
    /** Mirrors the bubble's alignment. When `right`, the chevron moves to
     *  the right end of the header (and switches to a left-pointing icon
     *  when collapsed), the header content is right-justified, and the body
     *  text is right-aligned. */
    alignment?: Alignment;
    headerClass?: string;
  } = $props();

  let isRight = $derived(alignment === "right");
  let chevronCollapsed = $derived(
    isRight
      ? "i-material-symbols-chevron-left-rounded"
      : "i-material-symbols-chevron-right-rounded",
  );
  let chevronIcon = $derived(
    expanded
      ? "i-material-symbols-keyboard-arrow-down-rounded"
      : chevronCollapsed,
  );
  // Pull the chevron a hair toward the bubble edge so the icon's optical
  // center sits flush — left pad on the left chevron, right pad on the right.
  let chevronMargin = $derived(isRight ? "-mr-0.5" : "-ml-0.5");
</script>

<div class="flex flex-col gap-2">
  <button
    class="{headerClass} {isRight ? 'justify-end' : ''}"
    {disabled}
    onclick={() => (expanded = !expanded)}
    title={expanded ? "Collapse" : "Expand"}
  >
    {#if !isRight}
      <i
        class="flex transition-transform duration-200 {chevronMargin} {chevronIcon}"
      ></i>
    {/if}
    {@render title()}
    {#if isRight}
      <i
        class="flex transition-transform duration-200 {chevronMargin} {chevronIcon}"
      ></i>
    {/if}
  </button>
  {#if expanded}
    <div transition:expand class={isRight ? "text-right" : ""}>
      {@render children()}
    </div>
  {/if}
</div>
