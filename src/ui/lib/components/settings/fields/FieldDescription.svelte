<script lang="ts">
  type Variant = "default" | "preset";

  let {
    text,
    variant = "default",
    class: extraClass = "",
  }: { text: string; variant?: Variant; class?: string } = $props();

  const paragraphs = $derived(text.split(/\n+/));
  const paragraphClass = $derived(
    variant === "preset"
      ? `text-sm leading-snug whitespace-pre-line ${extraClass}`
      : `text-sm leading-tight whitespace-pre-line text-default-500 ${extraClass}`,
  );
</script>

<div class="description-scroll flex flex-col gap-1">
  {#each paragraphs as paragraph}
    <p class={paragraphClass}>
      {paragraph}
    </p>
  {/each}
</div>

<style>
  .description-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    max-width: 100%;
  }
  .description-scroll::-webkit-scrollbar {
    height: 6px;
  }
  .description-scroll::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }
  .description-scroll::-webkit-scrollbar-thumb {
    background: var(--default-200);
    border-radius: 4px;
  }
  .description-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-400);
  }
  :global(html.dark) .description-scroll::-webkit-scrollbar-thumb {
    background: var(--default-d-200);
  }
  :global(html.dark) .description-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-d-400);
  }
</style>
