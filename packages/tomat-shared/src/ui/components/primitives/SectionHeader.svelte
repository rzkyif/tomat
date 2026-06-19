<script lang="ts">
  import type { Snippet } from "svelte";

  // A settings header row: an uppercase label, optional badge, and either a
  // collapse toggle (section level) or right-aligned actions (group level), with
  // a fade strip below. Shared so client and website render headers identically.
  type Level = "group" | "section";

  let {
    label,
    collapsible = false,
    expanded = true,
    onToggle,
    badge,
    actions,
    level = "section",
    class: extraClass = "",
  }: {
    label: string;
    collapsible?: boolean;
    expanded?: boolean;
    onToggle?: () => void;
    badge?: Snippet;
    /** Right-aligned controls (expand-all / collapse-all), only on the
     *  non-collapsible (group) header (nesting buttons in the collapsible
     *  header's <button> would be invalid HTML). */
    actions?: Snippet;
    level?: Level;
    class?: string;
  } = $props();

  const textColor = $derived(level === "group" ? "text-default-800" : "text-default-500");
  const hoverColor = $derived(level === "group" ? "" : "hov:text-default-700 transition-colors");
  const chevronIcon = $derived(
    expanded ? "i-material-symbols-expand-more-rounded" : "i-material-symbols-chevron-right-rounded",
  );
</script>

<div class="relative {extraClass}">
  {#if collapsible}
    <button
      class="flex items-center gap-1 h-7 bg-surface text-base {textColor} {hoverColor} font-medium uppercase tracking-wide cursor-pointer w-full"
      onclick={onToggle}
    >
      <!-- -ml-0.5 pulls the chevron's optical left edge flush with the group
           header text above (matches Expandable's chevron nudge). -->
      <i class="inline-block transition-transform duration-200 -ml-0.5 {chevronIcon}"></i>
      <span>{label}</span>
      {#if badge}
        {@render badge()}
      {/if}
    </button>
  {:else}
    <div
      class="flex items-center gap-2 h-7 bg-surface text-base {textColor} font-medium uppercase tracking-wide"
    >
      <span>{label}</span>
      {#if badge}
        {@render badge()}
      {/if}
      {#if actions}
        <div class="ml-auto flex items-center gap-1">
          {@render actions()}
        </div>
      {/if}
    </div>
  {/if}
  <!-- Fade below the header: matches the top padding above the next section
       header, drawn on top of it (group header is higher z), so at rest it only
       covers the padding strip; a header scrolling up dissolves under it. -->
  <div
    class="absolute left-0 right-0 top-full h-1.5 bg-gradient-to-b from-default-50 to-transparent pointer-events-none"
  ></div>
</div>
