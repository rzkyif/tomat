<script lang="ts">
  type Variant = "labels" | "pill";

  let {
    checked,
    onchange,
    disabled = false,
    variant = "labels",
    labels = { on: "on", off: "off" },
    ariaLabel,
    class: extraClass = "",
  }: {
    checked: boolean;
    onchange?: (v: boolean) => void;
    disabled?: boolean;
    /** `labels` (default) is the full-width settings switch with embedded
     *  "on"/"off" labels that slide across the track. `pill` is the compact
     *  iOS-style switch with a sliding circular thumb, used for quick
     *  toggles where state should read at a glance without explicit labels. */
    variant?: Variant;
    /** Only used when variant === "labels". */
    labels?: { on: string; off: string };
    ariaLabel?: string;
    class?: string;
  } = $props();
</script>

<label
  class="relative {variant === 'pill'
    ? 'inline-flex'
    : 'flex w-full'} items-center cursor-pointer {disabled
    ? 'opacity-60 pointer-events-none'
    : ''} {extraClass}"
  style:--toggle-on={`"${labels.on}"`}
  style:--toggle-off={`"${labels.off}"`}
>
  <input
    type="checkbox"
    aria-label={ariaLabel}
    class="sr-only peer"
    {checked}
    {disabled}
    onchange={(e) =>
      onchange?.((e.target as HTMLInputElement).checked)}
  />
  {#if variant === "pill"}
    <div
      class="tomat-toggle-pill w-11 h-6 relative bg-default-400 peer-focus:outline-none rounded-full peer peer-checked:bg-default-inverted-300 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-default-100 after:transition-transform peer-checked:after:translate-x-5 shrink-0"
    ></div>
  {:else}
    <div
      class="tomat-toggle w-full h-2em relative bg-default-300 peer-focus:outline-none rounded-medium peer peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-default-400 after:text-center after:text-xs after:content-center after:uppercase after:absolute after:top-0.25em after:left-0.25em after:bg-default-200 after:text-default-500 after:rounded-medium after:h-2.16em after:w-[calc(50%-0.25em)] after:transition-all"
    ></div>
  {/if}
</label>

<style>
  /* Custom-label support: the peer-checked variant flips the pseudo-element
     content between the off- and on-labels. The labels themselves come from
     the consumer via CSS custom properties so the same component can read
     "on/off", "yes/no", or any localized pair. */
  .tomat-toggle::after {
    content: var(--toggle-off, "off");
  }
  :global(input:checked + .tomat-toggle::after) {
    content: var(--toggle-on, "on");
  }
</style>
