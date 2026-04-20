<script lang="ts">
  import { settingsState } from "../../state";
  import { ttsState } from "$lib/state/tts.svelte";
  import { getTextContent, type MessageContent } from "$lib/shared/types";
  import Bubble from "../Bubble.svelte";
  import MessageMarkdown from "./MessageMarkdown.svelte";
  import ReasoningTrace from "./ReasoningTrace.svelte";
  import { showAgentMessageMenu } from "$lib/shared/messageMenu";

  let {
    id,
    content,
    modelUsed = "default",
    reasoning,
    reasoningDurationMs,
    pending = false,
    isStreaming = false,
    onReprocess,
    onDelete,
  } = $props<{
    id?: string;
    content: MessageContent;
    modelUsed?: "default" | "secondary";
    reasoning?: string;
    reasoningDurationMs?: number;
    pending?: boolean;
    isStreaming?: boolean;
    onReprocess?: () => void;
    onDelete?: () => void;
  }>();

  let displayText = $derived(getTextContent(content));
  let bgClass = $derived(
    modelUsed === "secondary" ? "bg-accent-purple-300" : "bg-accent-blue-300",
  );
  let pillBgClass = $derived(
    modelUsed === "secondary" ? "bg-accent-purple-200" : "bg-accent-blue-200",
  );
  let borderColorClass = $derived(
    modelUsed === "secondary"
      ? "border-accent-purple-400"
      : "border-accent-blue-400",
  );

  let showReasoningSetting = $derived(
    !!settingsState.currentSettings["llm.showReasoning"],
  );
  let hasReasoning = $derived(
    showReasoningSetting &&
      typeof reasoning === "string" &&
      reasoning.length > 0,
  );
  let showSpinner = $derived(pending && !displayText && !hasReasoning);

  let isMine = $derived(
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
    id !== undefined && ttsState.enabled && ttsState.loaded,
  );
</script>

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
      hasReasoning,
      result: displayText,
      reasoning,
      ttsActive,
      isSpeakingThis,
      isSynthesizing:
        isMine && ttsState.liveSourceCount === 0 && ttsState.synthInflight,
      onReprocess,
      onDelete,
    });
  }}
>
  {#if showSpinner}
    <i class="i-line-md:loading-alt-loop text-3xl"></i>
  {:else}
    {#if hasReasoning}
      <ReasoningTrace
        reasoning={reasoning as string}
        {isStreaming}
        hasText={!!displayText}
        {pillBgClass}
        {reasoningDurationMs}
      />
    {/if}
    <MessageMarkdown content={displayText} />
  {/if}
</Bubble>
