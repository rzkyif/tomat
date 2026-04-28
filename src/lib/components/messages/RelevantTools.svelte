<script lang="ts">
  import type { RelevantToolsState } from "$lib/shared/types";
  import Bubble from "../Bubble.svelte";
  import Expandable from "../Expandable.svelte";
  import { settingsState } from "../../state";
  import { expansionState } from "$lib/state/expansion.svelte";
  import { untrack } from "svelte";

  let {
    id,
    relevantTools,
    neighborLeft = false,
    neighborRight = false,
  }: {
    id?: string;
    relevantTools: RelevantToolsState;
    neighborLeft?: boolean;
    neighborRight?: boolean;
  } = $props();

  // The headline count tracks whichever phase actually fed the main model:
  // phase 2 when the LLM filter ran, phase 1 otherwise.
  let count = $derived(
    relevantTools.phase2 !== null
      ? relevantTools.phase2.length
      : relevantTools.phase1.length,
  );

  let titleText = $derived.by(() => {
    if (relevantTools.status === "filtering")
      return "Finding relevant tools...";
    if (relevantTools.status === "error")
      return "Failed to find relevant tools";
    if (count === 0) return "No relevant tools";
    const noun = `relevant tool${count === 1 ? "" : "s"}`;
    return `Found ${count} ${noun}`;
  });

  let isLoading = $derived(relevantTools.status === "filtering");

  let expanded = $state(
    untrack(() =>
      id !== undefined ? (expansionState.get(id) ?? false) : false,
    ),
  );
  // Bidirectional sync with expansionState — see SystemMessage.svelte for
  // the rationale. Cross-side reads are wrapped in `untrack` so each effect
  // only fires on its own side's changes; otherwise a local toggle and an
  // external mutation race and the wrong value wins.
  $effect(() => {
    if (id === undefined) return;
    const stored = expansionState.get(id) ?? false;
    untrack(() => {
      if (stored !== expanded) expanded = stored;
    });
  });
  $effect(() => {
    if (id === undefined) return;
    const local = expanded;
    untrack(() => {
      const current = expansionState.get(id) ?? false;
      if (current !== local) expansionState.set(id, local);
    });
  });

  function formatScore(s: number): string {
    return s.toFixed(2);
  }
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  size="small"
  progress={isLoading ? null : undefined}
  {neighborLeft}
  {neighborRight}
>
  <Expandable bind:expanded alignment={settingsState.getAlignment()}>
    {#snippet title()}
      <span>{titleText}</span>
    {/snippet}
    {#snippet children()}
      <div class="flex flex-col gap-2 text-xs">
        {#if relevantTools.errorMessage}
          <div class="flex flex-col gap-1">
            <div class="text-accent-red-700 font-bold">Filter Error</div>
            <pre
              class="font-mono text-accent-red-900 bg-accent-red-100 border border-accent-red-300 rounded-md px-2 py-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{relevantTools.errorMessage}</pre>
            <div class="text-accent-red-700">
              Phase-1 candidates are kept as a fallback so the main model still
              sees tools.
            </div>
          </div>
        {/if}

        <div class="flex flex-col gap-1">
          <div class="text-default-600 font-bold">
            Phase 1: Embedding Similarity ({relevantTools.phase1.length})
          </div>
          {#if relevantTools.phase1.length === 0}
            <div class="text-default-500 italic px-3 py-2">No candidates.</div>
          {:else}
            <div
              class="bg-card-default rounded-2xl px-4 py-2 font-mono text-default-800 whitespace-pre-wrap break-words"
            >
              {#each relevantTools.phase1 as tool, i (tool.id ?? i)}{#if i > 0},
                {/if}{tool.name}<span class="text-default-500 tabular-nums"
                  >&nbsp;({formatScore(tool.score)})</span
                >{/each}
            </div>
          {/if}
        </div>

        {#if relevantTools.phase2 !== null}
          <div class="flex flex-col gap-1">
            <div class="text-default-600 font-bold">
              Phase 2: LLM Filter ({relevantTools.phase2.length})
            </div>
            {#if relevantTools.phase2.length === 0}
              <div
                class="bg-card-default rounded-2xl px-4 py-2 text-default-500"
              >
                No tools survived the filter.
              </div>
            {:else}
              <div
                class="bg-card-default rounded-2xl px-4 py-2 font-mono text-default-800 whitespace-pre-wrap break-words"
              >
                {#each relevantTools.phase2 as tool, i (tool.name + i)}{#if i > 0},
                  {/if}{tool.name}{/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/snippet}
  </Expandable>
</Bubble>
