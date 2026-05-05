<script lang="ts">
  import { confirmState, downloadsState } from "../../state";
  import DownloadRow from "./DownloadRow.svelte";

  // Esc closes the modal, but defers to ConfirmModal when both are open
  // (e.g. user opened the queue, then changed a setting that triggered a
  // confirm) so Esc dismisses one layer at a time.
  $effect(() => {
    if (!downloadsState.modalOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmState.pending) return;
      e.preventDefault();
      downloadsState.closeModal();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // Order: completed first (most recent at top), then active, then queued,
  // then cancelled, then errored. Within each bucket, oldest-added first.
  const sortedItems = $derived(() => {
    const order: Record<string, number> = {
      Completed: 0,
      Downloading: 1,
      Pending: 2,
      Cancelled: 3,
      Error: 4,
    };
    return [...downloadsState.items].sort((a, b) => {
      const oa = order[a.status] ?? 99;
      const ob = order[b.status] ?? 99;
      if (oa !== ob) return oa - ob;
      return a.added_at_ms - b.added_at_ms;
    });
  });

  const hasCompleted = $derived(downloadsState.completed.length > 0);
</script>

{#if downloadsState.modalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute inset-0 bg-black/20 backdrop-blur flex items-center justify-center z-50 rounded-large"
    onclick={() => downloadsState.closeModal()}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bg-default-300 rounded-large p-5 w-[calc(100%-2rem)] max-w-md flex flex-col gap-3 max-h-[80vh]"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="flex items-center justify-between">
        <div class="text-default-800 font-medium">Downloads</div>
        <button
          class="flex p-1 rounded-full hover:bg-default-400 text-default-600 hover:text-default-800 hover:cursor-pointer transition-colors"
          onclick={() => downloadsState.closeModal()}
          title="Close"
          aria-label="Close downloads"
        >
          <i class="flex i-material-symbols-close-rounded text-lg"></i>
        </button>
      </div>

      {#if downloadsState.items.length === 0}
        <div
          class="bg-default-200 rounded-medium px-4 py-6 text-default-500 text-sm text-center"
        >
          No downloads
        </div>
      {:else}
        <div class="flex flex-col gap-1 overflow-y-auto pr-1">
          {#each sortedItems() as item (item.id)}
            <DownloadRow {item} />
          {/each}
        </div>
      {/if}

      {#if hasCompleted}
        <div class="flex items-center justify-end">
          <button
            class="bg-default-200 hover:bg-default-400 text-default-700 px-3 py-1.5 text-sm rounded-medium hover:cursor-pointer transition-colors"
            onclick={() => downloadsState.clearCompleted()}
          >
            Clear completed
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
