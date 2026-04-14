<script lang="ts">
  import type { Snippet } from "$lib/shared/snippets";

  let { options, selectedIndex, anchor, onSelect } = $props<{
    options: Snippet[];
    selectedIndex: number;
    anchor: { top: number; left: number };
    onSelect: (snippet: Snippet) => void;
  }>();
</script>

{#if options.length > 0}
  <div
    class="fixed z-50 bg-default-100 rounded-xl shadow-lg border border-default-300 overflow-hidden min-w-48 max-w-80 max-h-72 overflow-y-auto"
    style="top: {anchor.top}px; left: {anchor.left}px;"
    role="listbox"
  >
    {#each options as option, i (option.id)}
      <button
        type="button"
        class="w-full text-left flex items-center justify-between gap-3 px-3 py-2 text-sm hover:cursor-pointer transition-colors {i ===
        selectedIndex
          ? 'bg-blue-500/20 text-default-900'
          : 'text-default-800 hover:bg-default-200'}"
        onmousedown={(e) => {
          e.preventDefault();
          onSelect(option);
        }}
        role="option"
        aria-selected={i === selectedIndex}
      >
        <span class="truncate flex-1">{option.name || option.trigger}</span>
        <span class="text-xs text-default-500 font-mono shrink-0">{option.trigger}</span>
      </button>
    {/each}
  </div>
{/if}
