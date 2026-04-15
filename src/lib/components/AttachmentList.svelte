<script lang="ts">
  import type { MessagePart } from "$lib/shared/types";
  import { readSessionAttachment } from "$lib/shared/attachments";

  let {
    parts,
    editable = false,
    onRemove,
    onImageClick,
  } = $props<{
    parts: MessagePart[];
    editable?: boolean;
    onRemove?: (index: number) => void;
    onImageClick?: (url: string) => void;
  }>();

  // Cache: attachment path -> data URL (resolved lazily for image_file parts)
  let imageUrlCache = $state<Record<string, string>>({});

  async function ensureImageUrl(path: string, mime: string): Promise<string> {
    if (imageUrlCache[path]) return imageUrlCache[path];
    try {
      const b64 = await readSessionAttachment(path);
      const url = `data:${mime};base64,${b64}`;
      imageUrlCache = { ...imageUrlCache, [path]: url };
      return url;
    } catch (e) {
      console.warn("[attach] failed to read image:", path, e);
      return "";
    }
  }

  // Kick off loads for any image_file parts we don't yet have
  $effect(() => {
    for (const p of parts) {
      if (p.type === "image_file" && !imageUrlCache[p.path]) {
        void ensureImageUrl(p.path, p.mime);
      }
    }
  });
</script>

{#if parts.length > 0}
  <div class="flex flex-wrap gap-2">
    {#each parts as part, i}
      {#if part.type === "image_url"}
        <div
          class="relative group bg-default-100 p-2 rounded-lg {editable &&
          onRemove
            ? 'pr-7'
            : ''}"
        >
          {#if onImageClick}
            <button
              class="block p-0 border-0 bg-transparent hover:cursor-pointer"
              onclick={() => onImageClick(part.image_url.url)}
              title="View Full Image"
            >
              <img
                src={part.image_url.url}
                alt="Attached"
                class="h-16 w-16 object-cover"
              />
            </button>
          {:else}
            <img
              src={part.image_url.url}
              alt="Attached"
              class="h-16 w-16 object-cover"
            />
          {/if}
          {#if editable && onRemove}
            <button
              class="absolute top-1 right-1 text-default-400 hover:text-red-500 rounded-full w-5 h-5 flex items-center justify-center transition-opacity cursor-pointer"
              onclick={() => onRemove(i)}
              title="Remove Attachment"
            >
              <i class="flex i-material-symbols-close-rounded text-sm"></i>
            </button>
          {/if}
        </div>
      {:else if part.type === "image_file"}
        {@const url = imageUrlCache[part.path] || ""}
        <div
          class="relative group bg-default-100 p-2 rounded-lg {editable &&
          onRemove
            ? 'pr-7'
            : ''}"
        >
          {#if url}
            {#if onImageClick}
              <button
                class="block p-0 border-0 bg-transparent hover:cursor-pointer"
                onclick={() => onImageClick(url)}
                title="View Full Image"
              >
                <img src={url} alt="Attached" class="h-16 w-16 object-cover" />
              </button>
            {:else}
              <img src={url} alt="Attached" class="h-16 w-16 object-cover" />
            {/if}
          {:else}
            <div
              class="h-16 w-16 flex items-center justify-center text-default-400"
            >
              <i
                class="flex i-material-symbols-image-outline-rounded text-2xl"
              ></i>
            </div>
          {/if}
          {#if editable && onRemove}
            <button
              class="absolute top-1 right-1 text-default-400 hover:text-red-500 rounded-full w-5 h-5 flex items-center justify-center transition-opacity cursor-pointer"
              onclick={() => onRemove(i)}
              title="Remove Attachment"
            >
              <i class="flex i-material-symbols-close-rounded text-sm"></i>
            </button>
          {/if}
        </div>
      {:else if part.type === "document" || part.type === "document_file"}
        <div
          class="relative group flex items-center gap-1 bg-default-100 px-3 py-1.5 rounded-lg text-sm text-default-600 h-fit"
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
