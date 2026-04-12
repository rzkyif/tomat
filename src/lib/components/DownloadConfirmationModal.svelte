<script lang="ts">
  import type { DownloadPlan } from "$lib/downloader/plan";

  let { plans, onConfirm, onCancel } = $props<{
    plans: DownloadPlan[];
    onConfirm: () => void;
    onCancel: () => void;
  }>();

  function formatBytes(b: number | null): string {
    if (b == null) return "size unknown";
    if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
    if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  const total = $derived(
    plans.reduce((s: number, p: DownloadPlan) => s + (p.size_bytes ?? 0), 0),
  );
  const anyUnknown = $derived(plans.some((p: DownloadPlan) => p.size_bytes == null));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="absolute inset-0 bg-black/40 backdrop-blur flex items-center justify-center z-50 rounded-2xl"
  onclick={onCancel}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="bg-neutral-100 dark:bg-neutral-800 rounded-2xl shadow-xl border border-neutral-300 dark:border-neutral-700 p-5 w-[calc(100%-2rem)] max-w-md flex flex-col gap-3"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="text-default-800 font-medium">Download required</div>
    <div class="text-default-600 text-sm">
      The following file{plans.length === 1 ? "" : "s"} will be downloaded to
      <code>~/.tomat/models/</code>:
    </div>
    <div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
      {#each plans as p (p.path)}
        <div class="flex items-center gap-2 bg-default-200 rounded-lg px-3 py-2">
          <i
            class="flex i-material-symbols-cloud-download-outline-rounded text-default-500"
          ></i>
          <div class="flex flex-col flex-1 min-w-0">
            <div class="text-default-800 text-sm truncate">{p.filename}</div>
            <div class="text-default-500 text-xs truncate">{p.path}</div>
          </div>
          <div class="text-default-500 text-xs tabular-nums shrink-0">
            {formatBytes(p.size_bytes)}
          </div>
        </div>
      {/each}
    </div>
    <div class="flex items-center justify-between text-sm">
      <span class="text-default-500">
        Total: {formatBytes(total)}{anyUnknown ? " +" : ""}
      </span>
      <div class="flex gap-2">
        <button
          class="px-3 py-1.5 text-sm rounded-lg bg-default-200 hover:bg-default-300 text-default-800 hover:cursor-pointer transition-colors"
          onclick={onCancel}
        >
          Cancel
        </button>
        <button
          class="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white hover:cursor-pointer transition-colors"
          onclick={onConfirm}
        >
          Download
        </button>
      </div>
    </div>
  </div>
</div>
