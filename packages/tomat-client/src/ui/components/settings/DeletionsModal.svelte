<script lang="ts">
  import { deletionsState } from "../../state";
  import { formatBytes } from "$lib/util/format";
  import Modal from "../ui/Modal.svelte";
  import Button from "../ui/Button.svelte";
</script>

{#if deletionsState.pending}
  {@const p = deletionsState.pending}
  {@const total = p.items.reduce((s, i) => s + i.sizeBytes, 0)}
  <Modal open onclose={() => deletionsState.cancel()} ariaLabel={p.title} class="max-h-[80vh]">
    <div class="text-default-800 font-medium">{p.title}</div>
    {#if p.notice}
      <div class="text-default-600 text-sm whitespace-pre-line">{p.notice}</div>
    {/if}

    {#if p.items.length > 0}
      <div class="text-default-500 text-xs uppercase tracking-wide">Will be deleted</div>
      <div class="tomat-scroll flex flex-col gap-1 max-h-56 overflow-y-auto pr-1">
        {#each p.items as item (item.label)}
          <div class="flex items-center gap-2 bg-surface-inset rounded-medium px-3 py-2">
            <i class="flex i-material-symbols-delete-outline-rounded text-default-500"></i>
            <div class="text-default-800 text-sm truncate flex-1 min-w-0">{item.label}</div>
            <div class="text-default-500 text-xs tabular-nums shrink-0">
              {formatBytes(item.sizeBytes)}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if p.skipped.length > 0}
      <div class="text-default-500 text-xs uppercase tracking-wide">In use, will be kept</div>
      <div class="tomat-scroll flex flex-col gap-1 max-h-32 overflow-y-auto pr-1">
        {#each p.skipped as s (s.label)}
          <div class="flex items-center gap-2 rounded-medium px-3 py-1.5 opacity-70">
            <i class="flex i-material-symbols-lock-outline text-default-500"></i>
            <div class="text-default-700 text-sm truncate flex-1 min-w-0">{s.label}</div>
            <div class="text-default-500 text-xs truncate shrink-0">{s.reason}</div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="flex items-center justify-end gap-2">
      {#if total > 0}
        <span class="text-default-500 text-sm mr-auto">Frees {formatBytes(total)}</span>
      {/if}
      <Button variant="secondary" onclick={() => deletionsState.cancel()}>Cancel</Button>
      <Button
        variant="destructive"
        onclick={() => deletionsState.confirm()}
        disabled={p.items.length === 0 && !p.notice}
      >
        {p.confirmLabel ?? "Delete"}
      </Button>
    </div>
  </Modal>
{/if}
