<script lang="ts">
  import type { Message } from "$lib/util/types";
  import RelevantDocumentsView from "@tomat/shared/ui/components/chat/messages/RelevantDocumentsView.svelte";

  let {
    id,
    msg,
    neighborLeft = false,
    neighborRight = false,
  }: {
    id?: string;
    msg: Message;
    neighborLeft?: boolean;
    neighborRight?: boolean;
  } = $props();
</script>

<RelevantDocumentsView
  {id}
  docs={msg.relevant ?? []}
  status={msg.status ?? "complete"}
  errorMessage={msg.errorMessage}
  {neighborLeft}
  {neighborRight}
/>
