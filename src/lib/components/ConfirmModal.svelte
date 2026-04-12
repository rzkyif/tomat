<script lang="ts">
  import { confirmState } from "../state";
</script>

{#if confirmState.pending}
  {@const p = confirmState.pending}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute inset-0 bg-black/40 backdrop-blur flex items-center justify-center z-50 rounded-2xl"
    onclick={() => confirmState.cancel()}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bg-neutral-100 dark:bg-neutral-800 rounded-2xl shadow-xl border border-neutral-300 dark:border-neutral-700 p-5 w-[calc(100%-2rem)] max-w-md flex flex-col gap-3"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="text-default-800 font-medium">{p.title}</div>
      <div class="text-default-600 text-sm whitespace-pre-line">
        {p.message}
      </div>
      <div class="flex justify-end gap-2">
        <button
          class="px-3 py-1.5 text-sm rounded-lg bg-default-200 hover:bg-default-300 text-default-800 hover:cursor-pointer transition-colors"
          onclick={() => confirmState.cancel()}
        >
          Cancel
        </button>
        <button
          class="px-3 py-1.5 text-sm rounded-lg {p.destructive
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-blue-600 hover:bg-blue-700 text-white'} hover:cursor-pointer transition-colors"
          onclick={() => confirmState.confirm()}
        >
          {p.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </div>
  </div>
{/if}
