<script lang="ts">
  import { confirmState } from "../../state";
  import { formatBytes } from "$lib/shared/format";
  import { isBinarySource, binarySourceToKind } from "$lib/shared/download";
  import type { DownloadPlan } from "@tomat/shared";
  import Modal from "../ui/Modal.svelte";
  import Button from "../ui/Button.svelte";

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
</script>

{#if confirmState.pending}
  {@const p = confirmState.pending}
  {@const downloads = p.downloads ?? []}
  {@const total = downloads.reduce((s, d) => s + (d.sizeHint ?? 0), 0)}
  {@const anyUnknown = downloads.some((d) => d.sizeHint == null)}
  <Modal
    open
    onclose={() => confirmState.cancel()}
    ariaLabel={p.title}
  >
    <div class="text-default-800 font-medium">{p.title}</div>
    <div class="text-default-600 text-sm whitespace-pre-line">
      {p.message}
    </div>
    {#if downloads.length > 0}
      <div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {#each downloads as d (d.source)}
          <div
            class="flex items-center gap-2 bg-default-200 rounded-medium px-3 py-2"
          >
            <i
              class="flex i-material-symbols-cloud-download-outline-rounded text-default-500"
            ></i>
            <div class="flex flex-col flex-1 min-w-0">
              <div class="text-default-800 text-sm truncate">
                {displayTitle(d.source)}
              </div>
              <div class="text-default-500 text-xs truncate">
                {displaySubtitle(d)}
              </div>
            </div>
            {#if d.sizeHint}
              <div class="text-default-500 text-xs tabular-nums shrink-0">
                {formatBytes(d.sizeHint)}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <div class="flex items-center justify-end gap-2">
      {#if downloads.length > 0 && total > 0}
        <span class="text-default-500 text-sm mr-auto">
          Total: {formatBytes(total)}{anyUnknown ? " +" : ""}
        </span>
      {/if}
      {#if !p.alert}
        <Button variant="secondary" onclick={() => confirmState.cancel()}>
          {p.cancelLabel ?? "Cancel"}
        </Button>
      {/if}
      <Button
        variant={p.destructive ? "destructive" : "primary"}
        onclick={() => confirmState.confirm()}
      >
        {p.confirmLabel ?? "Confirm"}
      </Button>
    </div>
  </Modal>
{/if}
