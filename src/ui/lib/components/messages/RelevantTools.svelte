<script lang="ts">
  import type {
    RelevantToolPhase1Entry,
    RelevantToolPhase2Entry,
    RelevantToolsState,
  } from "$lib/shared/types";
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

  // Active sections, in the order they ran. The "Phase N" label in the UI
  // is derived from this array's index. It represents execution order, not
  // a fixed mapping to method. Skipped methods (filter off, secondPass off,
  // no always-available tools) drop out of the array entirely so the
  // remaining sections renumber 1..N seamlessly.
  type ScoredPhase = { kind: "embedding"; entries: RelevantToolPhase1Entry[] };
  type PlainPhase = {
    kind: "llm" | "always";
    entries: RelevantToolPhase2Entry[];
  };
  type Phase = ScoredPhase | PlainPhase;

  let phases = $derived.by<Phase[]>(() => {
    const out: Phase[] = [];
    if (relevantTools.phase1 !== null) {
      out.push({ kind: "embedding", entries: relevantTools.phase1 });
    }
    if (relevantTools.phase2 !== null) {
      out.push({ kind: "llm", entries: relevantTools.phase2 });
    }
    if (
      relevantTools.alwaysAvailable !== null &&
      relevantTools.alwaysAvailable !== undefined &&
      relevantTools.alwaysAvailable.length > 0
    ) {
      out.push({ kind: "always", entries: relevantTools.alwaysAvailable });
    }
    return out;
  });

  function phaseLabel(kind: Phase["kind"]): string {
    if (kind === "embedding") return "Embedding";
    if (kind === "llm") return "LLM Filter";
    return "Always Available Tools";
  }

  function phaseEmptyText(kind: Phase["kind"]): string {
    if (kind === "embedding") return "No candidates matched.";
    if (kind === "llm") return "No tools survived the filter.";
    return "No tools.";
  }

  // Headline count = tools actually sent to the model. The filter pipeline's
  // contribution is whichever filter phase ran last (phase 2 if present, else
  // phase 1, else 0); always-available tools are appended on top.
  let bypassCount = $derived(relevantTools.alwaysAvailable?.length ?? 0);
  let baseCount = $derived(
    relevantTools.phase2 !== null
      ? relevantTools.phase2.length
      : (relevantTools.phase1?.length ?? 0),
  );
  let count = $derived(baseCount + bypassCount);

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
  // Bidirectional sync with expansionState. See SystemMessage.svelte for
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

        {#each phases as phase, i (phase.kind)}
          <div class="flex flex-col gap-1">
            <div class="text-default-600 font-bold">
              Phase {i + 1}: {phaseLabel(phase.kind)} ({phase.entries.length})
            </div>
            {#if phase.entries.length === 0}
              <div class="text-default-500 italic px-3 py-2">
                {phaseEmptyText(phase.kind)}
              </div>
            {:else if phase.kind === "embedding"}
              <div
                class="bg-card-default rounded-2xl px-4 py-2 font-mono text-default-800 whitespace-pre-wrap break-words"
              >
                {#each phase.entries as tool, ti (tool.id ?? ti)}{#if ti > 0},
                  {/if}{tool.name}<span class="text-default-500 tabular-nums"
                    >&nbsp;({formatScore(tool.score)})</span
                  >{/each}
              </div>
            {:else}
              <div
                class="bg-card-default rounded-2xl px-4 py-2 font-mono text-default-800 whitespace-pre-wrap break-words"
              >
                {#each phase.entries as tool, ti (tool.name + ti)}{#if ti > 0},
                  {/if}{tool.name}{/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/snippet}
  </Expandable>
</Bubble>
