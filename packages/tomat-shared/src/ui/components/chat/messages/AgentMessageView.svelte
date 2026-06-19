<script lang="ts">
  import type { Snippet } from "svelte";
  import Bubble from "../../primitives/Bubble.svelte";
  import ReasoningTraceView from "./ReasoningTraceView.svelte";
  import { useUiContext } from "../../../context.ts";

  // Presentational agent message. `kind: "reasoning"` renders a small
  // `bg-surface` bubble wrapping the reasoning disclosure; `kind: "content"`
  // renders the answer bubble (`bubble-agent`/`-secondary`). The markdown body
  // is supplied by the caller (client: MessageMarkdown; website: plain prose),
  // so this stays free of the heavy markdown pipeline. Alignment via context.
  const ui = useUiContext();

  let {
    kind,
    bgClass = "bubble-agent",
    isStreaming = false,
    reasoningDurationMs,
    reasoningExpanded = $bindable(false),
    active = false,
    pulse = false,
    neighborLeft = false,
    neighborRight = false,
    oncontextmenu,
    body,
  }: {
    kind: "reasoning" | "content";
    /** Content bubble background (`bubble-agent` or `bubble-agent-secondary`). */
    bgClass?: string;
    isStreaming?: boolean;
    reasoningDurationMs?: number;
    reasoningExpanded?: boolean;
    /** Content bubble active border + pulse (the client drives these from TTS). */
    active?: boolean;
    pulse?: boolean;
    neighborLeft?: boolean;
    neighborRight?: boolean;
    oncontextmenu?: (e: MouseEvent) => void;
    /** The message body: reasoning content or the answer markdown. */
    body: Snippet;
  } = $props();
</script>

{#if kind === "reasoning"}
  <Bubble
    selectedAlignment={ui.getAlignment()}
    bgClass="bg-surface"
    extraClass="markdown overflow-clip"
    size="small"
    {neighborLeft}
    {neighborRight}
    {oncontextmenu}
  >
    <ReasoningTraceView
      {isStreaming}
      {reasoningDurationMs}
      bind:expanded={reasoningExpanded}
      pillBgClass="bg-surface-inset"
      {body}
    />
  </Bubble>
{:else}
  <Bubble
    selectedAlignment={ui.getAlignment()}
    {bgClass}
    extraClass="markdown overflow-clip flex flex-col gap-3"
    {active}
    {pulse}
    {oncontextmenu}
  >
    {@render body()}
  </Bubble>
{/if}
