<script lang="ts">
  import { onDestroy } from "svelte";
  import MessageMarkdown from "./MessageMarkdown.svelte";
  import Expandable from "../../ui/Expandable.svelte";
  import { settingsState } from "$lib/state";
  import { hasAlpha } from "$lib/shared/color";

  const override = $derived(
    settingsState.currentSettings[
      "appearance.systemMessageDefaultColor"
    ] as string,
  );
  const overrideHex = $derived(hasAlpha(override) ? override : null);

  let {
    reasoning,
    isStreaming,
    pillBgClass,
    reasoningDurationMs,
    expanded = $bindable(false),
  }: {
    reasoning: string;
    /** True while reasoning chunks are still arriving for this bubble.
     *  Cleared by messagesState as soon as the first content chunk lands or
     *  the stream finishes; at which point the elapsed timer freezes. */
    isStreaming: boolean;
    pillBgClass: string;
    /** Persisted duration from storage, used as the fallback elapsed time
     *  for historic messages where we can't live-track the stream. */
    reasoningDurationMs?: number;
    /** Bindable so the parent (AgentMessage) can wire this into the shared
     *  expansion map for chain-break detection. */
    expanded?: boolean;
  } = $props();

  let receivingReasoning = $derived(isStreaming);

  let startTime = $state<number | null>(null);
  let nowTime = $state(Date.now());
  let finalMs = $state<number | null>(null);
  let tickTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleNextTick() {
    const elapsed = startTime !== null ? Date.now() - startTime : 0;
    const intervalMs = elapsed < 1000 ? 100 : 1000;
    tickTimer = setTimeout(() => {
      nowTime = Date.now();
      scheduleNextTick();
    }, intervalMs);
  }

  $effect(() => {
    if (receivingReasoning) {
      if (startTime === null) startTime = Date.now();
      finalMs = null;
      nowTime = Date.now();
      if (!tickTimer) scheduleNextTick();
    } else {
      if (tickTimer) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
      if (startTime !== null && finalMs === null) {
        finalMs = Date.now() - startTime;
      }
    }
  });

  onDestroy(() => {
    if (tickTimer) clearTimeout(tickTimer);
  });

  function formatElapsed(ms: number): string {
    const safeMs = Math.max(0, ms);
    if (safeMs < 1000) {
      return `0.${Math.floor(safeMs / 100)}s`;
    }
    const totalSec = Math.floor(safeMs / 1000);
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

<div style:display="contents" style:--default-base={overrideHex}>
  <Expandable bind:expanded alignment={settingsState.getAlignment()}>
    {#snippet title()}
      <span>{headerText}</span>
    {/snippet}
    {#snippet children()}
      <!-- `text-left` keeps the reasoning markdown alignment-independent;
           the Expandable wrapper would otherwise right-align it when the
           bubble is right-aligned. -->
      <div
        class="{pillBgClass} px-4 py-2 rounded-large text-default-700 text-xs text-left"
      >
        <MessageMarkdown content={reasoning} />
      </div>
    {/snippet}
  </Expandable>
</div>
