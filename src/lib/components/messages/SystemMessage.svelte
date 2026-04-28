<script lang="ts">
  import { untrack } from "svelte";
  import Bubble from "../Bubble.svelte";
  import Expandable from "../Expandable.svelte";
  import { settingsState } from "../../state";
  import { expansionState } from "$lib/state/expansion.svelte";

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
  // External → local sync: mirror SvelteMap mutations (e.g. from
  // MessageStackGroup's collapseAll) into local state so the body actually
  // unmounts. The cross-side read is wrapped in `untrack` so the effect
  // only re-runs when expansionState changes — without that, a local toggle
  // would also fire this effect and revert the user's click before the
  // local→external effect could write the new value back.
  $effect(() => {
    if (id === undefined) return;
    const stored = expansionState.get(id) ?? false;
    untrack(() => {
      if (stored !== expanded) expanded = stored;
    });
  });
  // Local → external sync. Symmetric: the expansionState read is untracked
  // so external mutations don't fire this effect into overwriting them.
  $effect(() => {
    if (id === undefined) return;
    const local = expanded;
    untrack(() => {
      const current = expansionState.get(id) ?? false;
      if (current !== local) expansionState.set(id, local);
    });
  });
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  size="small"
  {neighborLeft}
  {neighborRight}
>
  <Expandable bind:expanded alignment={settingsState.getAlignment()}>
    {#snippet title()}
      <span>System Prompt</span>
    {/snippet}
    {#snippet children()}
      <div
        class="whitespace-pre-wrap bg-card-default text-default-700 text-xs px-4 py-2 rounded-2xl"
      >
        {content}
      </div>
    {/snippet}
  </Expandable>
</Bubble>
