<script lang="ts">
  import { CSS_EASING, getDuration } from "$lib/shared/animations";

  type Variant = "labels" | "pill";
  type Option = { value: string; label: string };

  let {
    // Binary mode (default): a single on/off switch.
    checked = false,
    onchange,
    /** `labels` (default) is the full-width settings switch with embedded
     *  "on"/"off" labels. `pill` is the compact iOS-style switch with a
     *  sliding circular knob, used for quick toggles where state should read
     *  at a glance without explicit labels. */
    variant = "labels",
    /** Only used when variant === "labels". */
    labels = { on: "on", off: "off" },
    // Segmented mode: supplying `options` renders 2+ mutually exclusive choices
    // as one labelled switch (same scheme as the `labels` variant), reporting
    // the picked value through `onselect`.
    options,
    value,
    onselect,
    disabled = false,
    /** Slightly smaller, tighter label text so longer words (ENABLED/DISABLED,
     *  ALLOW/DENY) fit a narrow control. */
    compact = false,
    ariaLabel,
    class: extraClass = "",
  }: {
    checked?: boolean;
    onchange?: (value: boolean) => void;
    variant?: Variant;
    labels?: { on: string; off: string };
    options?: Option[];
    value?: string;
    onselect?: (value: string) => void;
    disabled?: boolean;
    compact?: boolean;
    ariaLabel?: string;
    class?: string;
  } = $props();

  let groupEl: HTMLDivElement | undefined = $state();

  // Every variant is the same control: a bg-surface-inset groove with all the
  // option text resting on it, and a default-inverted knob that slides to the
  // selected option. The knob is an aria-hidden overlay that repaints the same
  // cells in the inverted palette and is clipped to the selected cell with
  // clip-path: inset(); transitioning the clip rect both slides the knob and
  // flips each glyph's color exactly where the knob edge crosses it. The real
  // controls (the radios / the hidden checkbox) sit underneath and keep all
  // semantics. getDuration() ties the slide to the appearance animation
  // settings.
  const count = $derived(options?.length ?? 2);
  const selectedIndex = $derived(
    options ? options.findIndex((o) => o.value === value) : checked ? 1 : 0,
  );
  const isPill = $derived(!options && variant === "pill");
  const knobStyle = $derived.by(() => {
    const pad = isPill ? "0.125rem" : "0.25rem";
    const cell = `(100% - 2 * ${pad}) / ${count}`;
    const clip = selectedIndex < 0
      // No matching option: park the knob collapsed at the left padding edge.
      ? `inset(${pad} calc(100% - ${pad}) ${pad} ${pad})`
      : `inset(${pad} calc(${pad} + ${cell} * ${count - 1 - selectedIndex}) ${pad} calc(${pad} + ${cell} * ${selectedIndex}) round ${
        isPill ? "9999px" : "var(--rounded-medium)"
      })`;
    return `clip-path: ${clip}; transition: clip-path ${getDuration()}ms ${CSS_EASING};`;
  });
  // min-w-0 keeps the cells exactly equal-width even if a label overflows,
  // since the knob clip assumes uniform Nths.
  const cellClass = $derived(
    `flex-1 min-w-0 flex items-center justify-center px-2 uppercase tracking-wide ${
      compact ? "text-[0.625rem]" : "text-xs"
    }`,
  );

  // Standard radiogroup keyboard pattern for segmented mode: one tab stop
  // (roving tabindex), arrow keys move + select, Home/End jump to the ends.
  function onKeydown(e: KeyboardEvent): void {
    if (!options) return;
    const idx = options.findIndex((o) => o.value === value);
    if (idx < 0) return;
    let next = idx;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = (idx - 1 + options.length) % options.length;
    } else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    if (options[next].value !== value) onselect?.(options[next].value);
    groupEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
</script>

{#snippet knob(texts: string[])}
  <span
    aria-hidden="true"
    class="absolute inset-0 flex p-1 bg-default-inverted-300 text-default-inverted-900 pointer-events-none"
    style={knobStyle}
  >
    {#each texts as text}
      <span class={cellClass}>{text}</span>
    {/each}
  </span>
{/snippet}

{#if options}
  <!-- Segmented: N mutually exclusive options. -->
  <div
    bind:this={groupEl}
    class="groove relative flex w-full h-8 rounded-medium bg-surface-inset p-1 {disabled
      ? 'opacity-60 pointer-events-none'
      : ''} {extraClass}"
    role="radiogroup"
    aria-label={ariaLabel}
    tabindex={-1}
    onkeydown={onKeydown}
  >
    {#each options as opt (opt.value)}
      <button
        type="button"
        role="radio"
        aria-checked={value === opt.value}
        tabindex={value === opt.value ? 0 : -1}
        class="{cellClass} text-default-600 transition-colors hover:text-default-800 hover:cursor-pointer"
        onclick={() => onselect?.(opt.value)}
      >
        {opt.label}
      </button>
    {/each}
    {@render knob(options.map((o) => o.label))}
  </div>
{:else}
  <!-- Binary. A visually-hidden real checkbox carries the semantics (focus,
       form value, a11y, the test harness); the groove + knob are plain
       elements driven by the reactive `checked` prop. -->
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
      <span class="groove relative w-11 h-6 shrink-0 rounded-full bg-surface-inset">
        <span
          aria-hidden="true"
          class="absolute inset-0 bg-default-inverted-300 pointer-events-none"
          style={knobStyle}
        ></span>
      </span>
    {:else}
      <span
        class="groove relative flex w-full h-8 rounded-medium bg-surface-inset p-1 text-default-600"
      >
        <span class={cellClass}>{labels.off}</span>
        <span class={cellClass}>{labels.on}</span>
        {@render knob([labels.off, labels.on])}
      </span>
    {/if}
  </label>
{/if}

<style>
  /* The selected control sits under the opaque knob, where the UA focus ring
     would be painted over; resurface keyboard focus on the groove itself. */
  .groove:has(:focus-visible),
  label:has(:focus-visible) .groove {
    outline: auto;
    outline-offset: 1px;
  }
</style>
