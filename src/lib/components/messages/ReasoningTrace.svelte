<script lang="ts">
  import { onDestroy } from "svelte";
  import MessageMarkdown from "./MessageMarkdown.svelte";
  import { expand } from "$lib/shared/animations";

  let {
    reasoning,
    isStreaming,
    hasText,
    pillBgClass,
    reasoningDurationMs,
  }: {
    reasoning: string;
    isStreaming: boolean;
    /** True once the final answer has begun arriving. Used to detect the
     *  trailing edge of the reasoning stream so the elapsed timer can freeze. */
    hasText: boolean;
    pillBgClass: string;
    /** Persisted duration from storage, used as the fallback elapsed time
     *  for historic messages where we can't live-track the stream. */
    reasoningDurationMs?: number;
  } = $props();

  let receivingReasoning = $derived(isStreaming && !hasText);
  let reasoningExpanded = $state(false);

  let startTime = $state<number | null>(null);
  let nowTime = $state(Date.now());
  let finalMs = $state<number | null>(null);
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    if (receivingReasoning) {
      if (startTime === null) startTime = Date.now();
      finalMs = null;
      nowTime = Date.now();
      if (!tickInterval) {
        tickInterval = setInterval(() => {
          nowTime = Date.now();
        }, 1000);
      }
    } else {
      if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
      if (startTime !== null && finalMs === null) {
        finalMs = Date.now() - startTime;
      }
    }
  });

  onDestroy(() => {
    if (tickInterval) clearInterval(tickInterval);
  });

  function formatElapsed(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  let headerText = $derived.by(() => {
    if (receivingReasoning && startTime !== null) {
      return `Thinking for ${formatElapsed(nowTime - startTime)}...`;
    }
    const persistedMs = finalMs ?? reasoningDurationMs;
    if (persistedMs !== undefined) {
      return `Thought for ${formatElapsed(persistedMs)}`;
    }
    return "Reasoning";
  });
</script>

<div class="flex flex-col gap-2">
  <button
    class="flex items-center gap-1 text-default-900 text-sm font-bold hover:cursor-pointer w-full"
    onclick={() => (reasoningExpanded = !reasoningExpanded)}
    title={reasoningExpanded ? "Collapse reasoning" : "Expand reasoning"}
  >
    <i
      class="flex transition-transform duration-200 {reasoningExpanded
        ? 'i-material-symbols-keyboard-arrow-down-rounded'
        : 'i-material-symbols-chevron-right-rounded'}"
    ></i>
    <span>{headerText}</span>
  </button>
  {#if reasoningExpanded}
    <div transition:expand>
      <div class="{pillBgClass} px-4 py-2 rounded-2xl text-default-700">
        <MessageMarkdown content={reasoning} />
      </div>
    </div>
  {/if}
</div>
