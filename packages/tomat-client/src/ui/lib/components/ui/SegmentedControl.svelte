<script lang="ts">
  type Option = { value: string; label: string };

  let {
    value,
    options,
    onchange,
    ariaLabel,
    class: extraClass = "",
  }: {
    value: string;
    options: Option[];
    onchange: (v: string) => void;
    ariaLabel?: string;
    class?: string;
  } = $props();
</script>

<div
  class="flex gap-1 bg-default-200 rounded-large p-1 {extraClass}"
  role="radiogroup"
  aria-label={ariaLabel}
>
  {#each options as opt (opt.value)}
    {@const selected = value === opt.value}
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      class="flex-1 px-3 py-1.5 rounded-medium text-sm transition-colors hover:cursor-pointer {selected
        ? 'bg-default-400 text-default-900'
        : 'text-default-600 hover:text-default-800'}"
      onclick={() => onchange(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
</div>
