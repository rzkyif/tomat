<script lang="ts">
  import type { Message } from "$lib/util/types";
  import Bubble from "../../ui/Bubble.svelte";
  import Expandable from "../../ui/Expandable.svelte";
  import { settingsState } from "../../../state";
  import { expansionState } from "$stores/expansion.svelte";
  import { untrack } from "svelte";
  import { hasAlpha } from "$lib/appearance/color";

  const themeOverride = $derived(
    settingsState.currentSettings[
      "appearance.systemMessageDefaultColor"
    ] as string,
  );
  const themeOverrideHex = $derived(
    hasAlpha(themeOverride) ? themeOverride : null,
  );

  let {
    id,
    msg,
    neighborLeft = false,
    neighborRight = false,
  }: {
    id?: string;
    msg: Message;
    neighborLeft?: boolean;
    neighborRight?: boolean;
  } = $props();

  let status = $derived(msg.status ?? "complete");
  let docs = $derived(msg.relevant ?? []);
  let count = $derived(docs.length);

  let titleText = $derived.by(() => {
    if (status === "error") return "Failed to find relevant documents";
    if (count === 0) return "No relevant documents";
    const noun = `relevant document${count === 1 ? "" : "s"}`;
    return `Found ${count} ${noun}`;
  });

  let expanded = $state(
    untrack(() =>
      id !== undefined ? (expansionState.get(id) ?? false) : false,
    ),
  );
  // Bidirectional sync with expansionState, mirroring RelevantTools /
  // SystemMessage. Cross-side reads are untracked so a local toggle and an
  // external mutation don't race.
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

<div style:display="contents" style:--default-base={themeOverrideHex}>
<Bubble
  selectedAlignment={settingsState.getAlignment()}
  size="small"
  {neighborLeft}
  {neighborRight}
>
  <Expandable bind:expanded alignment={settingsState.getAlignment()}>
    {#snippet title()}
      <span>{titleText}</span>
    {/snippet}
    {#snippet children()}
      <!-- `text-left` cancels the Expandable wrapper's right-alignment so the
           body stays alignment-independent while the header label follows it. -->
      <div class="flex flex-col gap-2 text-xs text-left">
        {#if msg.errorMessage}
          <div class="flex flex-col gap-1">
            <div class="text-accent-red-700 font-bold">Filter Error</div>
            <pre
              class="tomat-scroll-inset font-mono text-accent-red-900 bg-accent-red-100 border border-accent-red-300 rounded-small px-2 py-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{msg.errorMessage}</pre>
          </div>
        {/if}

        {#if count === 0}
          <div class="text-default-500 italic px-3 py-2">
            No documents matched.
          </div>
        {:else}
          <div class="flex flex-col gap-1">
            {#each docs as doc, di (doc.documentId ?? di)}
              <div
                class="bg-surface-inset rounded-large px-4 py-2 text-default-800 whitespace-pre-wrap break-words"
              >
                <span class="font-bold">{doc.title}</span><span
                  class="text-default-500 tabular-nums font-mono"
                  >&nbsp;({formatScore(doc.score)})</span
                >
                {#if doc.summary}
                  <div class="text-default-600">{doc.summary}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/snippet}
  </Expandable>
</Bubble>
</div>
