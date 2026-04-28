<script lang="ts">
  import { untrack } from "svelte";
  import { settingsState } from "../../state";
  import { ttsState } from "$lib/state/tts.svelte";
  import { expansionState } from "$lib/state/expansion.svelte";
  import { getTextContent, type MessageContent } from "$lib/shared/types";
  import Bubble from "../Bubble.svelte";
  import MessageMarkdown from "./MessageMarkdown.svelte";
  import ReasoningTrace from "./ReasoningTrace.svelte";
  import {
    showAgentMessageMenu,
    showReasoningMessageMenu,
  } from "$lib/shared/messageMenu";

  // AgentMessage is a discriminated bubble: a `kind: "reasoning"` instance
  // shows the reasoning trace produced by the model in a `role: "reasoning"`
  // message, and a `kind: "content"` instance shows the markdown answer in a
  // `role: "assistant"` message. Reasoning and content are persisted as
  // separate Messages so the rest of the pipeline (LLM context, deletion,
  // reprocess) sees them as independent records.
  let {
    kind,
    id,
    content,
    modelUsed = "default",
    reasoningDurationMs,
    isStreaming = false,
    onReprocess,
    onDelete,
    neighborLeft = false,
    neighborRight = false,
  } = $props<{
    kind: "reasoning" | "content";
    id?: string;
    content: MessageContent;
    modelUsed?: "default" | "secondary";
    reasoningDurationMs?: number;
    isStreaming?: boolean;
    onReprocess?: () => void;
    onDelete?: () => void;
    neighborLeft?: boolean;
    neighborRight?: boolean;
  }>();

  // Reasoning bubbles participate in the small-bubble stack chain, so their
  // expanded state lives in the shared map (read by +page.svelte to break
  // chains around expanded bubbles). Content bubbles are large and never
  // expandable, so they don't need this.
  let reasoningExpanded = $state(
    untrack(() =>
      id !== undefined ? (expansionState.get(id) ?? false) : false,
    ),
  );
  // Bidirectional sync with expansionState (only meaningful for reasoning
  // kind; the content branch never reads `reasoningExpanded`). Cross-side
  // reads are wrapped in `untrack` so each effect fires on its own side's
  // changes only — otherwise a user toggle gets reverted by the
  // external→local effect before local→external can write through.
  $effect(() => {
    if (kind !== "reasoning" || id === undefined) return;
    const stored = expansionState.get(id) ?? false;
    untrack(() => {
      if (stored !== reasoningExpanded) reasoningExpanded = stored;
    });
  });
  $effect(() => {
    if (kind !== "reasoning" || id === undefined) return;
    const local = reasoningExpanded;
    untrack(() => {
      const current = expansionState.get(id) ?? false;
      if (current !== local) expansionState.set(id, local);
    });
  });

  let displayText = $derived(getTextContent(content));
  let bgClass = $derived(
    modelUsed === "secondary" ? "bg-accent-purple-300" : "bg-accent-blue-300",
  );
  let borderColorClass = $derived(
    modelUsed === "secondary"
      ? "border-accent-purple-400"
      : "border-accent-blue-400",
  );

  // TTS only attaches to content bubbles — reasoning is never read aloud.
  let isMine = $derived(
    kind === "content" &&
      id !== undefined &&
      ttsState.enabled &&
      ttsState.loaded &&
      ttsState.currentMessageId === id,
  );
  let isSpeakingThis = $derived(isMine && ttsState.liveSourceCount > 0);
  let ttsBusyThis = $derived(
    isMine && (ttsState.liveSourceCount > 0 || ttsState.synthInflight),
  );
  let ttsActive = $derived(
    kind === "content" &&
      id !== undefined &&
      ttsState.enabled &&
      ttsState.loaded,
  );
</script>

{#if kind === "reasoning"}
  <Bubble
    selectedAlignment={settingsState.getAlignment()}
    bgClass="bg-default-300"
    extraClass="markdown overflow-clip"
    size="small"
    {neighborLeft}
    {neighborRight}
    oncontextmenu={(e) => {
      e.preventDefault();
      void showReasoningMessageMenu({
        reasoning: displayText,
        onDelete,
      });
    }}
  >
    <ReasoningTrace
      reasoning={displayText}
      {isStreaming}
      pillBgClass="bg-card-default"
      {reasoningDurationMs}
      bind:expanded={reasoningExpanded}
    />
  </Bubble>
{:else}
  <Bubble
    selectedAlignment={settingsState.getAlignment()}
    {bgClass}
    extraClass="markdown overflow-clip flex flex-col gap-3"
    active={ttsBusyThis}
    pulse={ttsBusyThis && !isSpeakingThis}
    {borderColorClass}
    oncontextmenu={(e) => {
      if (!id) return;
      e.preventDefault();
      void showAgentMessageMenu({
        messageId: id,
        isStreaming,
        result: displayText,
        ttsActive,
        isSpeakingThis,
        isSynthesizing:
          isMine && ttsState.liveSourceCount === 0 && ttsState.synthInflight,
        onReprocess,
        onDelete,
      });
    }}
  >
    <MessageMarkdown content={displayText} />
  </Bubble>
{/if}
