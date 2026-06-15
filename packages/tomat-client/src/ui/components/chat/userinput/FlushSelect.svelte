<script lang="ts">
  import Select from "$components/ui/Select.svelte";

  // A dropdown that reads as part of the bubble background rather than a button
  // or card: just an icon + the selected label, with a transparent native
  // <select> overlaid (Select's "invisible" variant). Sits dim (placeholder
  // tone) until hovered, matching the input's other muted controls. Used by the
  // quick model controls, where horizontal space is tight.

  type OptionValue = string | number;
  // `label` is shown in the open dropdown; `display` (when set) is the shorter
  // text shown collapsed in the bar.
  type Option = {
    value: OptionValue;
    label: string;
    display?: string;
    disabled?: boolean;
  };

  let {
    value,
    options,
    onchange,
    ariaLabel,
    title,
    icon,
    disabled = false,
  }: {
    value: OptionValue;
    options: Option[];
    onchange: (v: string) => void;
    ariaLabel: string;
    title?: string;
    icon?: string;
    disabled?: boolean;
  } = $props();

  const current = $derived(options.find((o) => o.value === value));
</script>

<div
  class="relative flex items-center gap-1 min-w-0 text-sm text-default-400 transition-colors {disabled
    ? 'opacity-50'
    : 'hover:text-default-700'}"
  {title}
>
  {#if icon}
    <i class="flex shrink-0 text-base {icon}"></i>
  {/if}
  <span class="truncate tracking-wide">
    {current?.display ?? current?.label ?? value}
  </span>
  <Select
    variant="invisible"
    {value}
    {options}
    {onchange}
    {ariaLabel}
    {disabled}
  />
</div>
