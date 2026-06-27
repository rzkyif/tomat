<script lang="ts">
  import type { AskUserImageQuestion } from "../../../../../domain/session.ts";
  import type { DraftAnswer } from "../ToolCallView.svelte";

  let { q, qi, draft, selectedClasses, unselectedClasses, togglePick }: {
    q: AskUserImageQuestion;
    qi: number;
    draft: DraftAnswer | undefined;
    selectedClasses: string;
    unselectedClasses: string;
    togglePick: (idx: number, value: string, multi: boolean) => void;
  } = $props();
</script>

<img
  src={`data:${q.mime};base64,${q.dataB64}`}
  alt={q.question}
  class="max-h-64 max-w-full self-start rounded-small"
/>
<div class="flex flex-wrap gap-1">
  {#each q.actions as action (action.value)}
    <button
      type="button"
      data-tc-nav
      class="text-xs px-3 py-1 h-8 rounded cursor-pointer outline-none transition-colors duration-100 {draft
        ?.picks[0] === action.value
        ? selectedClasses
        : unselectedClasses}"
      onclick={() => togglePick(qi, action.value, false)}
    >
      {action.label}
    </button>
  {/each}
</div>
