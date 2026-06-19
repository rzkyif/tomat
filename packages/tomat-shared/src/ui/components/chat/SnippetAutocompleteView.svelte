<script lang="ts" module>
  // Anything with a name + @trigger can be offered: snippets and documents
  // share this dropdown.
  export type TriggerOption = { id: string; name: string; trigger: string };
</script>

<script lang="ts">
  import ListItem from "../primitives/ListItem.svelte";

  // Presentational autocomplete dropdown anchored at a fixed position, listing
  // trigger options. All behavior (which options, selection index, what a
  // selection does) is owned by the caller and supplied via props.
  let { options, selectedIndex, anchor, onSelect }: {
    options: TriggerOption[];
    selectedIndex: number;
    anchor: { top: number; left: number };
    onSelect: (option: TriggerOption) => void;
  } = $props();
</script>

{#if options.length > 0}
  <div
    class="tomat-scroll fixed z-50 bg-surface rounded-large shadow-xl border border-surface overflow-hidden min-w-48 max-w-80 max-h-72 overflow-y-auto pointer-events-auto"
    style="top: {anchor.top}px; left: {anchor.left}px;"
    role="listbox"
  >
    {#each options as option, i (option.id)}
      <!-- onmousedown (not onclick) so the textarea keeps focus through the
           selection; preventDefault avoids the blur. -->
      <ListItem
        direction="row"
        selected={i === selectedIndex}
        role="option"
        ariaSelected={i === selectedIndex}
        class="rounded-none px-4 py-2"
        onmousedown={(e) => {
          e.preventDefault();
          onSelect(option);
        }}
      >
        <span class="truncate flex-1 text-sm text-default-800">
          {option.name || option.trigger}
        </span>
        <span class="text-xs font-mono text-default-600 shrink-0">
          {option.trigger}
        </span>
      </ListItem>
    {/each}
  </div>
{/if}
