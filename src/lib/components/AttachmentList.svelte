<script lang="ts">
  import type { MessagePart } from "$lib/shared/types";

  let {
    parts,
    editable = false,
    onRemove,
  } = $props<{
    parts: MessagePart[];
    editable?: boolean;
    onRemove?: (index: number) => void;
  }>();
</script>

{#if parts.length > 0}
  <div class="flex flex-wrap gap-2">
    {#each parts as part, i}
      {#if part.type === "image_url"}
        <div class="relative group">
          <img
            src={part.image_url.url}
            alt="Attached"
            class="h-16 w-16 object-cover bg-default-100 p-2 rounded-lg"
          />
          {#if editable && onRemove}
            <button
              class="absolute -top-1 -right-1 bg-red-400 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              onclick={() => onRemove(i)}
              title="Remove Attachment"
            >
              <i class="flex i-material-symbols-close-rounded text-xs"></i>
            </button>
          {/if}
        </div>
      {:else if part.type === "document"}
        <div
          class="relative group flex items-center gap-1 bg-default-100 px-3 py-1.5 rounded-lg text-sm text-default-600"
        >
          <i
            class="flex i-material-symbols-description-outline-rounded text-base"
          ></i>
          <span class="max-w-32 truncate">{part.filename}</span>
          {#if editable && onRemove}
            <button
              class="ml-1 text-default-400 hover:text-red-500 cursor-pointer transition-colors"
              onclick={() => onRemove(i)}
              title="Remove Attachment"
            >
              <i class="flex i-material-symbols-close-rounded text-sm"></i>
            </button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}
