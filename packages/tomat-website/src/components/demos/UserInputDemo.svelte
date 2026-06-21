<script lang="ts">
  import type { ComponentProps } from "svelte";
  import UserInputView from "@tomat/shared/ui/components/chat/UserInputView.svelte";
  import { userInputSamples } from "@tomat/shared/ui/samples";
  import DemoFrame from "./DemoFrame.svelte";
  import Highlight from "./Highlight.svelte";

  // The input bar at the bottom of a session. The `voiceReady` scenario shows
  // the Voice Input mic button. Pass `highlightTarget` (a `[data-region=...]`
  // selector) to mark one part, such as the mic.
  type Scenario = keyof typeof userInputSamples;
  let { scenario = "withText", label, highlightLabel, highlightTarget }: {
    scenario?: Scenario;
    label?: string;
    highlightLabel?: string;
    highlightTarget?: string;
  } = $props();
  const props = $derived(userInputSamples[scenario] as ComponentProps<typeof UserInputView>);
</script>

<DemoFrame {label} highlighted={!!highlightTarget} designWidth={620}>
  <div class="mx-auto w-full max-w-[620px]">
    {#if highlightTarget}
      <Highlight label={highlightLabel} target={highlightTarget}>
        <UserInputView {...props} />
      </Highlight>
    {:else}
      <UserInputView {...props} />
    {/if}
  </div>
</DemoFrame>
