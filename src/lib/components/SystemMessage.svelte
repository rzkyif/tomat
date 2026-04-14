<script lang="ts">
  import Bubble from "./Bubble.svelte";
  import { settingsState } from "../state";

  let { content } = $props<{ content: string }>();

  let expanded = $state(false);
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  extraClass="flex flex-col gap-2"
>
  {#if expanded}
    <div class="whitespace-pre-wrap bg-default-100 px-4 py-2 rounded-2xl">
      {content}
    </div>
  {/if}
  <button
    class="flex items-center gap-1 text-sm text-default-700 hover:cursor-pointer transition-colors uppercase tracking-wide font-medium w-full {settingsState.getAlignment() ==
    'right'
      ? 'ml-auto flex-row-reverse'
      : ''}"
    onclick={() => (expanded = !expanded)}
    title={expanded ? "Collapse system prompt" : "Expand system prompt"}
  >
    <i
      class="flex transition-transform duration-200 {expanded
        ? 'i-material-symbols-keyboard-arrow-up-rounded'
        : settingsState.getAlignment() == 'right'
          ? 'i-material-symbols-chevron-left-rounded'
          : 'i-material-symbols-chevron-right-rounded'}"
    ></i>
    <span>System Prompt</span>
  </button>
</Bubble>
