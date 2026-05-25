<script lang="ts">
  import type { Snippet } from "svelte";

  type Level = "group" | "section";

  let {
    label,
    collapsible = false,
    expanded = true,
    onToggle,
    badge,
    level = "section",
    class: extraClass = "",
  }: {
    label: string;
    collapsible?: boolean;
    expanded?: boolean;
    onToggle?: () => void;
    badge?: Snippet;
    level?: Level;
    class?: string;
  } = $props();

  const textColor = $derived(
    level === "group" ? "text-default-800" : "text-default-500",
  );

  const hoverColor = $derived(
    level === "group" ? "" : "hover:text-default-700 transition-colors",
  );

  const chevronIcon = $derived(
    expanded
      ? "i-material-symbols-expand-more-rounded"
      : "i-material-symbols-chevron-right-rounded",
  );
</script>

<div class="relative {extraClass}">
  {#if collapsible}
    <button
      class="flex items-center gap-2 h-7 bg-default-300 text-sm {textColor} {hoverColor} font-medium uppercase tracking-wide cursor-pointer w-full"
      onclick={onToggle}
    >
      <i class="inline-block transition-transform duration-200 {chevronIcon}"></i>
      <span>{label}</span>
      {#if badge}
        {@render badge()}
      {/if}
    </button>
  {:else}
    <div
      class="flex items-center gap-2 h-7 bg-default-300 text-sm {textColor} font-medium uppercase tracking-wide"
    >
      <span>{label}</span>
      {#if badge}
        {@render badge()}
      {/if}
    </div>
  {/if}
  <div
    class="absolute left-0 right-0 top-full h-3 bg-gradient-to-b from-default-300 to-transparent pointer-events-none"
  ></div>
</div>
