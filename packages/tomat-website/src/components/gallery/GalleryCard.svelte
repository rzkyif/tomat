<script lang="ts">
  import type { Snippet } from "svelte";
  import Bubble from "@tomat/shared/ui/components/primitives/Bubble.svelte";

  // One labeled frame in the component gallery: a `Component · scenario` caption
  // over a render area painted as a dim focus grid on `bg-surface`, exactly the
  // homepage showcase / manual demo recipe (see DemoFrame.svelte). Like those
  // frames the card is a DOUBLE flip: `.demo-frame` renders the chrome + grid in
  // the opposite site theme, and a `.demo-unflip` wrapper restores the website
  // theme for the rendered component, so in dark mode the card reads light while
  // the component inside reads dark (and vice versa) - the component is shown the
  // way it actually ships. `mb-4` plus, for masonry tiles, `break-inside-avoid`
  // place it in the column flow.
  //
  // Each card is addressable: its label is an anchor to a slug id, so following
  // it sets that hash and the URL changes (copyable/shareable). Only the label
  // links; the card body is NOT clickable, so interacting with a rendered control
  // never navigates. No clipboard write (too disruptive); the URL change is the
  // affordance.
  //
  // surface: wrap the component in a real `Bubble` - the on-surface context that
  //   components shipping on top of a bubble (settings fields, the object
  //   scaffolding, and every primitive) expect, carrying the genuine bubble drop
  //   shadow + frosted halo so the wrap matches what the app paints. Without it a
  //   raw control sits on the flipped card chrome and reads as the opposite theme.
  //   Chat-message Views (already bubbles), modal Views (their own surface), and
  //   the shells render without it.
  // backdrop: the component renders its OWN overlay (a Modal/Popover/ActionSheet
  //   open over a dimmed backdrop), so the frame becomes a clipped, transformed
  //   containing block that pins those fixed/absolute layers to the card. The
  //   focus grid still paints behind, and the gallery CSS hides the modal's own
  //   blur scrim so the grid shows through (see site.css `.gallery-frame`).
  // wide: pull the tile out of the masonry column flow so it spans the whole
  //   width, for the large shells that need the room.
  let {
    label,
    surface = false,
    backdrop = false,
    wide = false,
    children,
  }: {
    label: string;
    surface?: boolean;
    backdrop?: boolean;
    wide?: boolean;
    children: Snippet;
  } = $props();

  // A stable, shareable anchor id derived from the label.
  const id = $derived(
    "c-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
  );

  // Narrow masonry tiles re-cap their rendered component to the card width (see
  // site.css `.gallery-frame-narrow`); wide shell rows keep the faithful 700px-
  // window proportions, where the bubble background and its drop shadow stay in
  // sync. So only non-wide cards carry the narrow class.
  const frameClass = $derived(wide ? "gallery-frame" : "gallery-frame gallery-frame-narrow");
</script>

<div {id} class={`scroll-mt-20 flex flex-col gap-2 mb-4 ${wide ? "" : "break-inside-avoid"}`}>
  <a
    href={`#${id}`}
    class="w-fit font-mono text-xs text-default-500 no-underline transition-interactive hov:text-default-700"
  >{label}</a>
  <div
    class={`demo-frame flat-shadow ${frameClass} relative rounded-medium bg-surface min-h-24 overflow-hidden ${
      backdrop ? "" : "flex items-center justify-center"
    }`}
    style={backdrop ? "transform: translateZ(0)" : undefined}
  >
    <!-- The grid stays on the flipped chrome theme; only the component below is
         restored to the website theme by `.demo-unflip`. -->
    <div class="focus-grid-frame" aria-hidden="true"></div>
    {#if backdrop}
      <div class="demo-unflip">
        {@render children()}
      </div>
    {:else}
      <!-- Horizontally scroll content too wide to fit, so it can never spill past
           the card, however narrow the viewport (mobile). `min-w-0` lets the scroll
           area shrink to the card; the inner is `w-fit min-w-full` (fit-content) so
           it CLAMPS to the card for wrappable content (which then wraps, no scroll)
           but GROWS to the content's min-content for unshrinkable content (a wide
           button row, a fixed-width session bubble), left-anchoring it for a clean
           scroll instead of centering it half-off the card. A grown inner also lets
           the surface bubble expand to wrap that content. The `p-6` sits inside the
           scroll area so drop shadows have room before the clip and the scrollbar
           tucks into the padding. -->
      <div
        class="demo-unflip tomat-scroll relative z-10 w-full max-w-full min-w-0 overflow-x-auto p-6"
      >
        <div class="flex w-fit min-w-full items-center justify-center">
          {#if surface}
            <!-- `fullWidth` makes the bubble track the inner row: it fills the card
                 for short/fill content (so a stretch component like ObjectManager
                 spans the card) yet grows with the row when wide content (a long
                 button bar) pushes the row past the card, so the bubble wraps it. -->
            <Bubble selectedAlignment="center" fullWidth extraClass="flex justify-center">
              {@render children()}
            </Bubble>
          {:else}
            {@render children()}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
