<!-- Collapsed bubble for a core-authored user message (a scheduled prompt
     or greeting instruction). Same construction as SystemMessage: a small
     Bubble holding an Expandable whose body is the prompt text, collapsed
     by default so the automated session opens on the agent's response. -->
<script lang="ts">
  import { untrack } from "svelte";
  import Bubble from "../../ui/Bubble.svelte";
  import Expandable from "../../ui/Expandable.svelte";
  import { settingsState } from "../../../state";
  import { expansionState } from "$stores/expansion.svelte";
  import { hasAlpha } from "$lib/appearance/color";

  const override = $derived(
    settingsState.currentSettings[
      "appearance.systemMessageDefaultColor"
    ] as string,
  );
  const overrideHex = $derived(hasAlpha(override) ? override : null);

  let {
    id,
    content,
    neighborLeft = false,
    neighborRight = false,
  }: {
    id?: string;
    content: string;
    neighborLeft?: boolean;
    neighborRight?: boolean;
  } = $props();

  let expanded = $state(
    untrack(() =>
      id !== undefined ? (expansionState.get(id) ?? false) : false,
    ),
  );
  // External → local and local → external expansion sync, same scheme as
  // SystemMessage (see the comments there).
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
</script>

<div style:display="contents" style:--default-base={overrideHex}>
  <Bubble
    selectedAlignment={settingsState.getAlignment()}
    size="small"
    {neighborLeft}
    {neighborRight}
  >
    <Expandable bind:expanded alignment={settingsState.getAlignment()}>
      {#snippet title()}
        <span>Automated Prompt</span>
      {/snippet}
      {#snippet children()}
        <div
          class="whitespace-pre-wrap bg-surface-inset text-default-700 text-xs text-left px-4 py-2 rounded-large"
        >
          {content}
        </div>
      {/snippet}
    </Expandable>
  </Bubble>
</div>
