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

<div class="flex flex-col gap-0.75">
  {#each paragraphs as paragraph}
    <p class={paragraphClass}>
      {paragraph}
    </p>
  {/each}
</div>
