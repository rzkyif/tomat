<script lang="ts">
  import Alert from "../../ui/Alert.svelte";

  let { original, onReject }: { original: string; onReject: () => void } = $props();
</script>

<Alert
  variant="info"
  icon={false}
  align="start"
  action={{
    icon: "i-material-symbols-refresh-rounded",
    title: "Reject autocorrect",
    onclick: onReject,
  }}
>
  <div class="flex items-start gap-2">
    <span class="shrink-0 font-medium">Before Autocorrect:</span>
    <span class="whitespace-pre-wrap break-words flex-1">
      {original}
    </span>
  </div>
</Alert>
