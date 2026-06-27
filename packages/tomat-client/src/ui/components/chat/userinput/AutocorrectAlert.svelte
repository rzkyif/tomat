<script lang="ts">
  import AutocorrectAlertView from "@tomat/shared/ui/components/chat/userinput/AutocorrectAlertView.svelte";

  let { original, onReject }: { original: string; onReject: () => void } = $props();
</script>

<AutocorrectAlertView {original} {onReject} />
