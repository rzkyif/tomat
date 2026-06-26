<script lang="ts">
  import type { Snippet } from "svelte";
  import ChatShellView from "@tomat/shared/ui/components/chat/ChatShellView.svelte";
  import CoreBar from "./CoreBar.svelte";
  import SessionBar from "./SessionBar.svelte";
  import UserInput from "./UserInput.svelte";

  // Feeds the live chat chrome (core status, session bar, composer) into the
  // shared ChatShellView and forwards the route-owned transcript. The shell
  // itself owns the desktop/mobile arrangement; this wrapper only supplies the
  // regions, so the layout stays single-source.
  let {
    stackDepth = 0,
    transcript,
  }: {
    stackDepth?: number;
    transcript: Snippet;
  } = $props();
</script>

<ChatShellView {stackDepth} {coreBar} {sessionBar} {input} {transcript} />

{#snippet coreBar()}
  <CoreBar />
{/snippet}

{#snippet sessionBar(zIndex: number)}
  <SessionBar {zIndex} />
{/snippet}

{#snippet input()}
  <UserInput />
{/snippet}
