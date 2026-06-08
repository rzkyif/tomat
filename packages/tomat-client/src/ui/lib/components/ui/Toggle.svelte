<script lang="ts">
  type Variant = "labels" | "pill";

  let {
    checked,
    onchange,
    disabled = false,
    variant = "labels",
    labels = { on: "on", off: "off" },
    compact = false,
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
    /** Slightly smaller, tighter label text for the `labels` variant, so longer
     *  words (ENABLED/DISABLED, ALLOWED/DENIED) fit a narrow control. */
    compact?: boolean;
    ariaLabel?: string;
    class?: string;
  } = $props();
</script>

<!-- A visually-hidden real checkbox carries the semantics (focus, form value,
     a11y, the test harness); the knob + track are plain elements driven by the
     reactive `checked` prop so the off/on styling is trivial to reason about. -->
<label
  class="relative {variant === 'pill'
    ? 'inline-flex'
    : 'flex w-full'} items-center cursor-pointer {disabled
    ? 'opacity-60 pointer-events-none'
    : ''} {extraClass}"
>
  <input
    type="checkbox"
    aria-label={ariaLabel}
    class="sr-only"
    {checked}
    {disabled}
    onchange={(e) => onchange?.((e.target as HTMLInputElement).checked)}
  />
  {#if variant === "pill"}
    <span
      class="relative w-11 h-6 shrink-0 rounded-full transition-colors {checked
        ? 'bg-default-inverted-300'
        : 'bg-default-400'}"
    >
      <span
        class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-surface transition-transform {checked
          ? 'translate-x-5'
          : ''}"
      ></span>
    </span>
  {:else}
    <span class="relative w-full h-8 rounded-medium bg-surface-inset">
      <span
        class="absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] flex items-center justify-center rounded-medium bg-default-inverted-300 text-default-inverted-900 uppercase transition-transform {compact
          ? 'text-[0.625rem]'
          : 'text-xs tracking-wide'} {checked ? 'translate-x-full' : ''}"
      >
        {checked ? labels.on : labels.off}
      </span>
    </span>
  {/if}
</label>
