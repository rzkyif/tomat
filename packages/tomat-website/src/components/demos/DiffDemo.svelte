<script lang="ts">
  import type { ComponentProps } from "svelte";
  import DiffView from "@tomat/shared/ui/components/chat/messages/DiffView.svelte";
  import { diffViewSamples } from "@tomat/shared/ui/samples";
  import DemoFrame from "./DemoFrame.svelte";

  // A before/after diff a tool can render inline in the session.
  let { label }: { label?: string } = $props();
</script>

<DemoFrame {label} designWidth={620}>
  <div class="mx-auto w-full max-w-[620px]">
    <DiffView {...diffViewSamples.default as ComponentProps<typeof DiffView>} />
  </div>
</DemoFrame>
