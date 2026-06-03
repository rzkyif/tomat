<script lang="ts">
  import { untrack } from "svelte";
  import Bubble from "../ui/Bubble.svelte";
  import Expandable from "../ui/Expandable.svelte";
  import { settingsState } from "../../state";
  import { expansionState } from "$lib/state/expansion.svelte";
  import { hasAlpha } from "$lib/shared/color";

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
  // External → local sync: mirror SvelteMap mutations (e.g. from
  // MessageStack's click-to-expand) into local state so the body actually
  // mounts/unmounts. The cross-side read is wrapped in `untrack` so the
  // effect only re-runs when expansionState changes. Without that, a local
  // toggle would also fire this effect and revert the user's click before
  // the local→external effect could write the new value back.
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

<div style:display="contents" style:--default-base={overrideHex}>
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
        <!-- `text-left` keeps the prompt body alignment-independent. The
             Expandable wrapper would otherwise apply `text-right` when the
             bubble is right-aligned. -->
        <div
          class="whitespace-pre-wrap bg-surface-inset text-default-700 text-xs text-left px-4 py-2 rounded-large"
        >
          {content}
        </div>
      {/snippet}
    </Expandable>
  </Bubble>
</div>
