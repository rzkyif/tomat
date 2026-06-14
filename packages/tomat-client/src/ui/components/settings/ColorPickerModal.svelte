<script lang="ts">
  import { colorPickerState } from "../../state";
  import { formatOklch, parseColor } from "$lib/appearance/color";
  import Popover from "../ui/Popover.svelte";
  import Button from "../ui/Button.svelte";

  // Working OKLCHa state. Re-seeded each time a new request opens so
  // re-opening the same field doesn't carry leftover slider values.
  let l = $state(0);
  let c = $state(0);
  let h = $state(0);
  let a = $state(1);
  let previousColor = $state<string | null>(null);
  // Whether the user actually moved a slider since the picker opened. When
  // false, Apply returns the exact initial color so the field's no-op guard
  // sees an unchanged value and never rewrites the store.
  let dirty = $state(false);

  // Seed colors hide the lightness slider (their lightness is not rendered;
  // only hue/chroma/alpha seed the theme scale). L stays at the seeded value.
  const lockLightness = $derived(!!colorPickerState.pending?.lockLightness);

  let lastRequest: typeof colorPickerState.pending = null;
  $effect(() => {
    const p = colorPickerState.pending;
    if (p && p !== lastRequest) {
      lastRequest = p;
      const seed = parseColor(p.initialColor);
      // initialColor already carries the right lightness (locked by ColorField
      // when lockLightness is set); we just hide the L slider.
      l = seed.l;
      c = seed.c;
      h = seed.h;
      a = seed.a;
      previousColor = p.initialColor;
      dirty = false;
    }
    if (!p) lastRequest = null;
  });

  const newColor = $derived(formatOklch({ l, c, h, a }));

  // Apply the working color, or the untouched original when nothing changed.
  function apply() {
    colorPickerState.apply(dirty ? newColor : (previousColor ?? newColor));
  }

  // Enter commits. Popover already handles Esc-to-close.
  $effect(() => {
    if (!colorPickerState.pending) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  function setL(e: Event) {
    l = parseFloat((e.target as HTMLInputElement).value);
    dirty = true;
  }
  function setC(e: Event) {
    c = parseFloat((e.target as HTMLInputElement).value);
    dirty = true;
  }
  function setH(e: Event) {
    h = parseFloat((e.target as HTMLInputElement).value);
    dirty = true;
  }
  function setA(e: Event) {
    a = parseFloat((e.target as HTMLInputElement).value);
    dirty = true;
  }

  function reset() {
    if (!previousColor) return;
    const seed = parseColor(previousColor);
    l = seed.l;
    c = seed.c;
    h = seed.h;
    a = seed.a;
    // Back to the original: treat as unchanged so Apply is a clean no-op.
    dirty = false;
  }
</script>

<Popover
  open={!!colorPickerState.pending}
  anchor={colorPickerState.pending?.anchor}
  onclose={() => colorPickerState.close()}
  class="w-72"
  ariaLabel="Color picker"
>
  <div class="grid grid-cols-[1.25rem_1fr_3rem] items-center gap-x-2 gap-y-2">
    {#if !lockLightness}
      <span class="text-default-700 text-sm">L</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={l}
        oninput={setL}
        class="w-full"
        aria-label="Lightness"
      />
      <span class="text-default-600 text-xs text-right tabular-nums">
        {l.toFixed(3)}
      </span>
    {/if}

    <span class="text-default-700 text-sm">C</span>
    <input
      type="range"
      min="0"
      max="0.4"
      step="0.001"
      value={c}
      oninput={setC}
      class="w-full"
      aria-label="Chroma"
    />
    <span class="text-default-600 text-xs text-right tabular-nums">
      {c.toFixed(3)}
    </span>

    <span class="text-default-700 text-sm">H</span>
    <input
      type="range"
      min="0"
      max="360"
      step="1"
      value={h}
      oninput={setH}
      class="w-full"
      aria-label="Hue"
    />
    <span class="text-default-600 text-xs text-right tabular-nums">
      {h.toFixed(0)}°
    </span>

    <span class="text-default-700 text-sm">A</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={a}
      oninput={setA}
      class="w-full"
      aria-label="Alpha"
    />
    <span class="text-default-600 text-xs text-right tabular-nums">
      {a.toFixed(2)}
    </span>
  </div>

  <div
    class="alpha-checkerboard rounded-medium overflow-hidden grid grid-rows-2 h-20"
  >
    <div style:background-color={newColor} title="New"></div>
    {#if previousColor}
      <div style:background-color={previousColor} title="Previous"></div>
    {/if}
  </div>

  <div class="flex flex-row items-center gap-2">
    <Button variant="secondary" class="flex-1" onclick={reset}>Reset</Button>
    <Button variant="secondary" class="flex-1" onclick={apply}>Apply</Button>
  </div>
</Popover>
