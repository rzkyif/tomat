<script lang="ts">
  import type { AskUserDiffQuestion } from "../../../../../domain/session.ts";
  import type { DraftAnswer } from "../ToolCallView.svelte";
  import DiffView from "../DiffView.svelte";

  let {
    q,
    qi,
    draft,
    selectedClasses,
    unselectedClasses,
    togglePick,
  }: {
    q: AskUserDiffQuestion;
    qi: number;
    draft: DraftAnswer | undefined;
    selectedClasses: string;
    unselectedClasses: string;
    togglePick: (idx: number, value: string, multi: boolean) => void;
  } = $props();
</script>

{#if q.title}
  <div class="text-xs text-default-600">{q.title}</div>
{/if}
<div class="max-h-48 overflow-auto">
  <DiffView before={q.before} after={q.after} />
</div>
<!-- Bottom action row: full-width split, affirmative (Accept) on the right. -->
<div class="flex gap-1">
  {#each [{ label: "Reject", value: "reject" }, { label: "Accept", value: "accept" }] as verdict (verdict.value)}
    <button
      type="button"
      data-tc-nav
      class="flex-1 text-xs px-3 h-8 rounded cursor-pointer outline-none transition-colors duration-100 {draft
        ?.picks[0] === verdict.value
        ? selectedClasses
        : unselectedClasses}"
      onclick={() => togglePick(qi, verdict.value, false)}
    >
      {verdict.label}
    </button>
  {/each}
</div>
