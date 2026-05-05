<script lang="ts">
  import { confirmState } from "../../state";
  import { formatBytes } from "$lib/shared/format";

  // Esc dismisses the dialog. Even in alert mode (no Cancel button) this
  // routes through `cancel()`, which clears the pending request without
  // running `onConfirm` - matches every other modal-style component in the
  // app, where Esc means "back out, do nothing."
  $effect(() => {
    if (!confirmState.pending) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        confirmState.cancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

{#if confirmState.pending}
  {@const p = confirmState.pending}
  {@const downloads = p.downloads ?? []}
  {@const total = downloads.reduce((s, d) => s + (d.size_bytes ?? 0), 0)}
  {@const anyUnknown = downloads.some((d) => d.size_bytes == null)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute inset-0 bg-black/20 backdrop-blur flex items-center justify-center z-50 rounded-2xl"
    onclick={() => confirmState.cancel()}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bg-default-300 rounded-2xl p-5 w-[calc(100%-2rem)] max-w-md flex flex-col gap-3"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="text-default-800 font-medium">{p.title}</div>
      <div class="text-default-600 text-sm whitespace-pre-line">
        {p.message}
      </div>
      {#if downloads.length > 0}
        <div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
          {#each downloads as d (d.path)}
            <div
              class="flex items-center gap-2 bg-default-200 rounded-lg px-3 py-2"
            >
              <i
                class="flex i-material-symbols-cloud-download-outline-rounded text-default-500"
              ></i>
              <div class="flex flex-col flex-1 min-w-0">
                <div class="text-default-800 text-sm truncate">
                  {d.filename}
                </div>
                <div class="text-default-500 text-xs truncate">{d.path}</div>
              </div>
              <div class="text-default-500 text-xs tabular-nums shrink-0">
                {formatBytes(d.size_bytes)}
              </div>
            </div>
          {/each}
        </div>
      {/if}
      <div class="flex items-center justify-end gap-2">
        {#if downloads.length > 0}
          <span class="text-default-500 text-sm mr-auto">
            Total: {formatBytes(total)}{anyUnknown ? " +" : ""}
          </span>
        {/if}
        {#if !p.alert}
          <button
            class="px-3 py-1.5 text-sm rounded-lg bg-default-200 text-default-800 hover:cursor-pointer transition-colors"
            onclick={() => confirmState.cancel()}
          >
            Cancel
          </button>
        {/if}
        <button
          class="px-3 py-1.5 text-sm rounded-lg {p.destructive
            ? 'bg-accent-red-200 text-white'
            : 'bg-accent-blue-200 text-white'} hover:cursor-pointer transition-colors"
          onclick={() => confirmState.confirm()}
        >
          {p.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </div>
  </div>
{/if}
