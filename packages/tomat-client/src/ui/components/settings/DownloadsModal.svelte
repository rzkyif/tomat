<script lang="ts">
  import { confirmState, downloadsState } from "../../state";
  import DownloadRow from "./DownloadRow.svelte";
  import Modal from "@tomat/shared/ui/components/primitives/Modal.svelte";
  import Button from "@tomat/shared/ui/components/primitives/Button.svelte";
  import IconButton from "@tomat/shared/ui/components/primitives/IconButton.svelte";

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
      return a.addedAtMs - b.addedAtMs;
    });
  });

  const hasCompleted = $derived(downloadsState.completed.length > 0);
</script>

<!-- Defer Esc to ConfirmModal when both layers are open, so each press
     dismisses one layer at a time. -->
<Modal
  open={downloadsState.modalOpen}
  onclose={() => downloadsState.closeModal()}
  dismissOnEsc={!confirmState.pending}
  class="max-h-[80vh]"
  ariaLabel="Downloads"
>
  <div class="flex items-center justify-between">
    <div class="text-default-800 font-medium">Downloads</div>
    <IconButton
      icon="i-material-symbols-close-rounded"
      title="Close"
      ariaLabel="Close downloads"
      surface="circle"
      variant="subtle"
      size="md"
      class="hover:bg-default-400"
      onclick={() => downloadsState.closeModal()}
    />
  </div>

  {#if downloadsState.items.length === 0}
    <div
      class="bg-surface-inset rounded-medium px-4 py-6 text-default-500 text-sm text-center"
    >
      No downloads
    </div>
  {:else}
    <div class="tomat-scroll flex flex-col gap-1 overflow-y-auto pr-1">
      {#each sortedItems() as item (item.id)}
        <DownloadRow {item} />
      {/each}
    </div>
  {/if}

  {#if hasCompleted}
    <div class="flex items-center justify-end">
      <Button
        variant="secondary"
        onclick={() => downloadsState.clearCompleted()}
        class="hover:bg-default-400"
      >
        Clear completed
      </Button>
    </div>
  {/if}
</Modal>
