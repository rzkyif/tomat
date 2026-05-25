<script lang="ts">
  import type { Snippet } from "svelte";
  import CollapsibleLabel from "./CollapsibleLabel.svelte";

  let {
    icon,
    label,
    collapsed,
    selected = false,
    badge,
    onclick,
    title,
    ariaLabel,
    ariaPressed,
    class: extraClass = "",
  }: {
    icon: string;
    label?: string;
    collapsed: boolean;
    selected?: boolean;
    /** Optional badge content positioned at the icon's top-right. */
    badge?: Snippet;
    onclick: () => void;
    title?: string;
    ariaLabel?: string;
    ariaPressed?: boolean;
    class?: string;
  } = $props();

  // Padding logic: with a label, the right padding collapses with the label
  // so the row reduces to a centred icon. Icon-only rows skip the
  // trailing-pad collapse to stay symmetric rectangles.
  const padRight = $derived(
    label ? (collapsed ? "pr-0" : "pr-2.5") : "pr-1.5",
  );

  const stateClass = $derived(
    selected
      ? "bg-default-300 text-default-900"
      : "text-default-500 hover:text-default-700 hover:bg-default-200",
  );
</script>

<button
  class="hover:cursor-pointer flex items-center h-8 pl-1.5 {padRight} gap-1.5 rounded-medium transition-[padding,colors,background-color] duration-200 {stateClass} {extraClass}"
  {title}
  aria-label={ariaLabel ?? label}
  aria-pressed={ariaPressed}
  {onclick}
>
  <span class="relative flex shrink-0">
    <i class="flex text-xl shrink-0 {icon}"></i>
    {#if badge}
      {@render badge()}
    {/if}
  </span>
  {#if label}
    <CollapsibleLabel {collapsed} class="text-base text-left">
      {label}
    </CollapsibleLabel>
  {/if}
</button>
