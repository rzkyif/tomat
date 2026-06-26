<script lang="ts">
  import IconButton from "@tomat/shared/ui/components/primitives/IconButton.svelte";
  import ObjectBadge from "@tomat/shared/ui/components/objects/ObjectBadge.svelte";
  import type { Badge } from "@tomat/shared/ui/components/objects/object-types.ts";
  import { useUiContext } from "@tomat/shared/ui/context.ts";
  import { RIPPLE_MS } from "@tomat/shared/ui/animations.ts";
  import { ripple } from "@tomat/shared/ui/actions/ripple.ts";
  import { type MenuRow, showObjectActionMenu } from "$lib/objects/menu";

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

  const ui = useUiContext();
  const rippleDuration = $derived(ui.animationDurationMs(RIPPLE_MS));
</script>

<!-- Three stacked rows (title + tags / description / meta + triple-dot) so the
     description spans the full card width instead of being boxed into a narrow
     left column beside the badges.
     `group` (only when openable) lets badges shift on card hover (ObjectBadge).
     When openable, a full-bleed overlay button makes the WHOLE card clickable
     (no dead cursor gaps); the card content is pointer-events-none so clicks
     fall through to it, and only the triple-dot re-enables pointer events. -->
<div
  class="relative flex flex-col gap-0.5 rounded-large px-3 py-2 transition-interactive {onOpen
    ? 'group hov:bg-surface-inset'
    : ''}"
>
  {#if onOpen}
    <!-- Full-bleed overlay carries the press ripple (the card content above it
         is pointer-events-none, so the splash sits behind the content). -->
    <button
      type="button"
      class="absolute inset-0 rounded-large hov:cursor-pointer transition-interactive"
      aria-label={`Open ${label}`}
      onclick={onOpen}
      use:ripple={{ durationMs: rippleDuration }}
    ></button>
  {/if}
  <!-- Row 1: title, with badges pinned to the right. -->
  <div class="relative flex items-center gap-2 pointer-events-none">
    <span class="text-base font-medium text-default-800 truncate min-w-0 flex-1">{label}</span>
    {#if badges.length > 0}
      <div class="shrink-0 flex items-center justify-end flex-wrap gap-1 select-none">
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
  </div>
  <!-- Row 2: description, free to use the full width. -->
  {#if description}
    <span class="relative text-sm text-default-700 line-clamp-2 pointer-events-none">{description}</span>
  {/if}
  <!-- Row 3: meta, with the triple-dot pinned to the right. -->
  {#if meta || menuRows.length > 0}
    <div class="relative flex items-center gap-2 min-h-6 pointer-events-none">
      {#if meta}
        <span class="text-xs text-default-600 truncate min-w-0 flex-1">{meta}</span>
      {/if}
      {#if menuRows.length > 0}
        <div class="ml-auto shrink-0 pointer-events-auto">
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
  {/if}
</div>
