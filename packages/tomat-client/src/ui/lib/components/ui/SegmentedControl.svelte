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

  let groupEl: HTMLDivElement | undefined = $state();

  // Standard radiogroup keyboard pattern: one tab stop (roving tabindex, below),
  // arrow keys move + select, Home/End jump to the ends. Without this the group
  // is mouse-only and every segment lands in the tab order.
  function onKeydown(e: KeyboardEvent) {
    const idx = options.findIndex((o) => o.value === value);
    if (idx < 0) return;
    let next = idx;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    if (options[next].value !== value) onchange(options[next].value);
    groupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
</script>

<div
  bind:this={groupEl}
  class="flex gap-1 bg-surface-inset rounded-large p-1 {extraClass}"
  role="radiogroup"
  aria-label={ariaLabel}
  tabindex={-1}
  onkeydown={onKeydown}
>
  {#each options as opt (opt.value)}
    {@const selected = value === opt.value}
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabindex={selected ? 0 : -1}
      class="flex-1 px-3 py-1.5 rounded-medium text-sm transition-colors hover:cursor-pointer {selected
        ? 'bg-default-400 text-default-900'
        : 'text-default-600 hover:text-default-800'}"
      onclick={() => onchange(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
</div>
