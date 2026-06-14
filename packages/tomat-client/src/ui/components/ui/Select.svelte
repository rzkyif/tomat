<script lang="ts">
  type Variant = "default" | "invisible";

  type OptionValue = string | number;
  type Option = { value: OptionValue; label: string; disabled?: boolean };

  let {
    value,
    options,
    onchange,
    disabled = false,
    variant = "default",
    ariaLabel,
    title,
    class: extraClass = "",
  }: {
    value: OptionValue;
    options: Option[];
    onchange?: (v: string) => void;
    disabled?: boolean;
    variant?: Variant;
    ariaLabel?: string;
    title?: string;
    class?: string;
  } = $props();

  // Every Select renders as one recessed inset well on the flat surface.
  const surfaceClass = "bg-surface-inset";
</script>

{#if variant === "invisible"}
  <select
    {disabled}
    {value}
    {title}
    aria-label={ariaLabel}
    onchange={(e) => onchange?.((e.target as HTMLSelectElement).value)}
    class="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base {extraClass}"
  >
    {#each options as option (option.value)}
      <option value={option.value} disabled={option.disabled}>{option.label}</option>
    {/each}
  </select>
{:else}
  <div class="relative w-full {disabled ? 'opacity-60' : ''} {extraClass}">
    <select
      {disabled}
      {value}
      {title}
      aria-label={ariaLabel}
      onchange={(e) => onchange?.((e.target as HTMLSelectElement).value)}
      class="appearance-none {surfaceClass} text-default-800 rounded-medium focus:ring-blue-500 focus:border-blue-500 block w-full h-8 px-2 pr-7 outline-none hover:cursor-pointer text-sm"
    >
      {#each options as option}
        <option value={option.value} disabled={option.disabled}>{option.label}</option>
      {/each}
    </select>
    <i
      class="i-material-symbols-expand-more-rounded absolute right-1.5 top-1/2 -translate-y-1/2 text-default-600 pointer-events-none"
    ></i>
  </div>
{/if}
