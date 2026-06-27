<script lang="ts">
  import { confirmState } from "../../state";
  import { formatBytes } from "$lib/util/format";
  import { binarySourceToKind, isBinarySource } from "@tomat/shared";
  import type { DownloadPlan } from "@tomat/shared";
  import ConfirmModalView from "@tomat/shared/ui/components/settings/ConfirmModalView.svelte";

  // Friendly display of `binary:llama-server` etc. The raw synthetic
  // source string is ugly. HF paths still get the filename-extract
  // treatment below.
  function displayTitle(source: string): string {
    if (isBinarySource(source)) {
      return binarySourceToKind(source);
    }
    return source.split("/").pop() ?? source;
  }

  function displaySubtitle(d: DownloadPlan): string {
    if (isBinarySource(d.source)) {
      // Show the resolved release; fall back to "latest" when the probe
      // couldn't pin a concrete version.
      return d.version ?? "latest";
    }
    return d.source;
  }

  // Checkbox value for the optional "do not show again" row. Reset whenever a
  // new request arrives so one dialog's choice can't leak into the next.
  let dontShowAgain = $state(false);
  $effect(() => {
    if (confirmState.pending) dontShowAgain = false;
  });
</script>

{#if confirmState.pending}
  {@const p = confirmState.pending}
  {@const downloads = p.downloads ?? []}
  {@const total = downloads.reduce((s, d) => s + (d.sizeHint ?? 0), 0)}
  {@const anyUnknown = downloads.some((d) => d.sizeHint == null)}
  <ConfirmModalView
    title={p.title}
    message={p.message}
    downloads={downloads.map((d) => ({
      source: d.source,
      title: displayTitle(d.source),
      subtitle: displaySubtitle(d),
      sizeText: d.sizeHint ? formatBytes(d.sizeHint) : undefined,
    }))}
    totalText={downloads.length > 0 && total > 0
      ? `Total: ${formatBytes(total)}${anyUnknown ? " +" : ""}`
      : undefined}
    dontShowAgainLabel={p.dontShowAgainLabel}
    bind:dontShowAgain
    cancelLabel={p.cancelLabel ?? "Cancel"}
    confirmLabel={p.confirmLabel ?? "Confirm"}
    destructive={p.destructive}
    hideCancel={!!p.alert}
    onConfirm={() => confirmState.confirm(p.dontShowAgainLabel ? dontShowAgain : undefined)}
    onCancel={() => confirmState.cancel()}
    onClose={() => confirmState.cancel()}
  />
{/if}
