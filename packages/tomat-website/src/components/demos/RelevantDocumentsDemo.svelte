<script lang="ts">
  import type { ComponentProps } from "svelte";
  import RelevantDocumentsView from "@tomat/shared/ui/components/chat/messages/RelevantDocumentsView.svelte";
  import { relevantDocumentsSamples } from "@tomat/shared/ui/samples";
  import DemoFrame from "./DemoFrame.svelte";

  // The documents tomat surfaced as relevant to a message.
  type Scenario = keyof typeof relevantDocumentsSamples;
  let { scenario = "found", label }: { scenario?: Scenario; label?: string } = $props();
</script>

<DemoFrame {label} designWidth={620}>
  <div class="mx-auto w-full max-w-[620px]">
    <RelevantDocumentsView
      {...relevantDocumentsSamples[scenario] as ComponentProps<typeof RelevantDocumentsView>}
    />
  </div>
</DemoFrame>
