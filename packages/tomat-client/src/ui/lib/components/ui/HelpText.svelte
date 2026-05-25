<script lang="ts">
  type Variant = "default" | "compact";

  let {
    text,
    variant = "default",
    class: extraClass = "",
  }: { text: string; variant?: Variant; class?: string } = $props();

  const paragraphs = $derived(text.split(/\n+/));
  const paragraphClass = $derived(
    variant === "compact"
      ? `text-sm leading-snug whitespace-pre-line ${extraClass}`
      : `text-sm leading-tight whitespace-pre-line text-default-500 ${extraClass}`,
  );
</script>

<div class="helptext-scroll flex flex-col gap-1 mb-2">
  {#each paragraphs as paragraph, i (i)}
    <p class={paragraphClass}>
      {paragraph}
    </p>
  {/each}
</div>

<style>
  .helptext-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    max-width: 100%;
  }
  .helptext-scroll::-webkit-scrollbar {
    height: 6px;
  }
  .helptext-scroll::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }
  .helptext-scroll::-webkit-scrollbar-thumb {
    background: var(--default-200);
    border-radius: 4px;
  }
  .helptext-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-400);
  }
  :global(html.dark) .helptext-scroll::-webkit-scrollbar-thumb {
    background: var(--default-d-200);
  }
  :global(html.dark) .helptext-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-d-400);
  }
</style>
