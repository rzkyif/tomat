<script lang="ts">
  import { colorPickerState } from "../../state";
  import { hexToOklch, oklchToHex } from "$lib/shared/color";

  // Working OKLCHa state. Re-seeded each time a new request opens so
  // re-opening the same field doesn't carry leftover slider values.
  let l = $state(0);
  let c = $state(0);
  let h = $state(0);
  let a = $state(1);
  let previousHex = $state<string | null>(null);

  let lastRequest: typeof colorPickerState.pending = null;
  $effect(() => {
    const p = colorPickerState.pending;
    if (p && p !== lastRequest) {
      lastRequest = p;
      const seed = hexToOklch(p.initialHex);
      l = seed.l;
      c = seed.c;
      h = seed.h;
      a = seed.a;
      previousHex = p.initialHex;
    }
    if (!p) lastRequest = null;
  });

  const newHex = $derived(oklchToHex({ l, c, h, a }));

  // Esc dismisses the popup; Enter commits. Mirrors the keydown handler
  // ConfirmModal uses, plus the Enter shortcut requested for Apply.
  $effect(() => {
    if (!colorPickerState.pending) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        colorPickerState.close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        colorPickerState.apply(newHex);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  let backdropEl: HTMLDivElement | undefined = $state();
  let popupEl: HTMLDivElement | undefined = $state();
  // Hide the popup until we've measured its real height and computed the
  // final position. Without this guard the popup briefly renders at the
  // backdrop's top-left corner before snapping into place.
  let popupStyle = $state("visibility: hidden;");

  function computeStyle() {
    if (!backdropEl || !popupEl) return;
    const p = colorPickerState.pending;
    if (!p) return;
    const aRect = p.anchor.getBoundingClientRect();
    const b = backdropEl.getBoundingClientRect();
    // Measure the actual popup height — the content (sliders, comparison
    // rect, button row, padding, gaps) varies and a hardcoded estimate
    // routinely under-counted, so the picker would pick "above" when the
    // real popup wouldn't fit and got clipped by the Bubble's overflow.
    const ph = popupEl.offsetHeight;
    const margin = 8;
    const cx = aRect.left - b.left + aRect.width / 2;
    const spaceAbove = aRect.top - b.top;
    const spaceBelow = b.bottom - aRect.bottom;

    let placeAbove: boolean;
    if (spaceAbove >= ph + margin) {
      placeAbove = true;
    } else if (spaceBelow >= ph + margin) {
      placeAbove = false;
    } else {
      // Neither side fits; pick the larger one and accept some clipping.
      placeAbove = spaceAbove > spaceBelow;
    }

    if (placeAbove) {
      const top = aRect.top - b.top - margin;
      popupStyle = `left: ${cx}px; top: ${top}px; transform: translate(-50%, -100%); visibility: visible;`;
    } else {
      const top = aRect.bottom - b.top + margin;
      popupStyle = `left: ${cx}px; top: ${top}px; transform: translate(-50%, 0); visibility: visible;`;
    }
  }

  $effect(() => {
    if (colorPickerState.pending) {
      // Reset to hidden on each fresh open so a re-open of a different
      // field doesn't flash at the previous position before re-measuring.
      popupStyle = "visibility: hidden;";
      // Double rAF: first frame lets Svelte mount the popup so layout can
      // run, second frame guarantees offsetHeight reflects the laid-out
      // size when we measure.
      requestAnimationFrame(() => requestAnimationFrame(() => computeStyle()));
    }
  });

  function setL(e: Event) {
    l = parseFloat((e.target as HTMLInputElement).value);
  }
  function setC(e: Event) {
    c = parseFloat((e.target as HTMLInputElement).value);
  }
  function setH(e: Event) {
    h = parseFloat((e.target as HTMLInputElement).value);
  }
  function setA(e: Event) {
    a = parseFloat((e.target as HTMLInputElement).value);
  }

  function reset() {
    if (!previousHex) return;
    const seed = hexToOklch(previousHex);
    l = seed.l;
    c = seed.c;
    h = seed.h;
    a = seed.a;
  }
</script>

<svelte:window onresize={computeStyle} />

{#if colorPickerState.pending}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="absolute inset-0 z-50 bg-black/20 backdrop-blur"
    onclick={() => colorPickerState.close()}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={popupEl}
      class="absolute w-72 bg-default-300 rounded-large p-5 flex flex-col gap-3"
      style={popupStyle}
      role="dialog"
      tabindex="-1"
      aria-label="Color picker"
      onclick={(e) => e.stopPropagation()}
    >
      <div
        class="grid grid-cols-[1.25rem_1fr_3rem] items-center gap-x-2 gap-y-2"
      >
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
        <span class="text-default-600 text-xs text-right tabular-nums"
          >{l.toFixed(3)}</span
        >

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
        <span class="text-default-600 text-xs text-right tabular-nums"
          >{c.toFixed(3)}</span
        >

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
        <span class="text-default-600 text-xs text-right tabular-nums"
          >{h.toFixed(0)}°</span
        >

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
        <span class="text-default-600 text-xs text-right tabular-nums"
          >{a.toFixed(2)}</span
        >
      </div>

      <div
        class="alpha-checkerboard rounded-medium overflow-hidden grid grid-rows-2 h-20"
      >
        <div style:background-color={newHex} title="New"></div>
        {#if previousHex}
          <div style:background-color={previousHex} title="Previous"></div>
        {/if}
      </div>

      <div class="flex flex-row items-center gap-2">
        <button
          type="button"
          class="flex-1 px-3 py-1.5 text-sm rounded-medium bg-default-200 text-default-800 hover:cursor-pointer transition-colors"
          onclick={reset}
        >
          Reset
        </button>
        <button
          type="button"
          class="flex-1 px-3 py-1.5 text-sm rounded-medium bg-default-200 text-default-800 hover:cursor-pointer transition-colors"
          onclick={() => colorPickerState.apply(newHex)}
        >
          Apply
        </button>
      </div>
    </div>
  </div>
{/if}

