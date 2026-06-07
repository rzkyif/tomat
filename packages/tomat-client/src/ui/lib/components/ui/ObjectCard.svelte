<script lang="ts">
  import IconButton from "./IconButton.svelte";
  import ObjectBadge from "./ObjectBadge.svelte";
  import type { Badge } from "./object-types.ts";
  import { type MenuRow, showObjectActionMenu } from "$lib/shared/object-menu";

  // A flush list row: left column (label / description / meta), right column
  // (badges pinned top, per-item triple-dot pinned bottom).
  let {
    label,
    description,
    meta,
    badges = [],
    menuRows = [],
    onOpen,
  }: {
    label: string;
    description?: string;
    meta?: string;
    badges?: Badge[];
    menuRows?: MenuRow[];
    onOpen?: () => void;
  } = $props();
</script>

<!-- `group` (only when openable) lets badges shift on card hover (ObjectBadge).
     When openable, a full-bleed overlay button makes the WHOLE card clickable
     (no dead cursor gaps); the card content is pointer-events-none so clicks
     fall through to it, and only the triple-dot re-enables pointer events. -->
<div
  class="relative flex items-stretch gap-2 rounded-large px-3 py-2 transition-colors {onOpen
    ? 'group hover:bg-surface-inset'
    : ''}"
>
  {#if onOpen}
    <button
      type="button"
      class="absolute inset-0 hover:cursor-pointer"
      aria-label={`Open ${label}`}
      onclick={onOpen}
    ></button>
  {/if}
  <div class="relative flex flex-col gap-0.5 min-w-0 flex-1 pointer-events-none">
    <span class="text-base font-medium text-default-800 truncate">{label}</span>
    {#if description}
      <span class="text-sm text-default-700 line-clamp-2">{description}</span>
    {/if}
    {#if meta}
      <span class="text-xs text-default-600 truncate">{meta}</span>
    {/if}
  </div>
  <div
    class="relative self-stretch shrink-0 flex flex-col items-end justify-between gap-1 pointer-events-none"
  >
    {#if badges.length > 0}
      <div class="flex items-center justify-end flex-wrap gap-1 select-none">
        {#each badges as badge (badge.label)}
          <ObjectBadge
            label={badge.label}
            icon={badge.icon}
            accent={badge.accent}
            title={badge.title}
          />
        {/each}
      </div>
    {/if}
    {#if menuRows.length > 0}
      <div class="pointer-events-auto">
        <IconButton
          icon="i-material-symbols-more-vert"
          title="More actions"
          size="sm"
          surface="none"
          onclick={() => void showObjectActionMenu(menuRows)}
        />
      </div>
    {/if}
  </div>
</div>
