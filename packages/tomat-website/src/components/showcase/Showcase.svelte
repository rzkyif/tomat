<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import gsap from "gsap";
  import ChatStage from "./ChatStage.svelte";
  import SettingsStage from "./SettingsStage.svelte";
  import DualModelStage from "./DualModelStage.svelte";
  import CustomToolStage from "./CustomToolStage.svelte";
  import SpeechStage from "./SpeechStage.svelte";
  import { makeUiContext, setUiContext } from "@tomat/shared/ui/context";
  import { getDefaultSettings } from "@tomat/shared/domain/settings/engine";
  import { BASE_MS } from "@tomat/shared/ui/animations";
  import { APP_H, APP_SHADOW, APP_W, type Timeline } from "../../lib/showcase";

  // Full-width horizontal snap-scroll track, one stage per snap unit. Each stage is
  // CSS-scaled independently to fit the leftover height (capped at MAX_SCALE). Only
  // the centred stage animates; neighbours peek, dimmed and frozen at time 0.
  type Handle = { timeline: Timeline; reset: () => void };

  // Design box = the app surface (APP_W wide) plus its shadow margin, CSS-scaled to
  // fit. DESIGN_H (tallest stage) is the fallback height; per-stage heights below.
  const DESIGN_W = APP_W + 2 * APP_SHADOW;
  const DESIGN_H = APP_H + 2 * APP_SHADOW;
  const MAX_SCALE = 1;
  // Gap between adjacent frames (part of the snap step) so peeking neighbours don't
  // touch the centred stage; shrinks to a thin gutter on phones, where none peek.
  const PANEL_GAP_WIDE = 48;
  const PANEL_GAP_NARROW = 12;
  const NARROW_W = 640;
  // Floor for the snap unit so the caption + bar/install keep the install-card width
  // (max-w-xl) and stay left-aligned when the scaled frame is narrower.
  const CAPTION_W = 576;

  const meta = [
    {
      title: "Chat with a local agent",
      desc: "Type an instruction, send it, and watch the model think and answer, all on your machine.",
    },
    {
      title: "Make it yours",
      desc: "Every surface is configurable: switch setting groups, collapse the sidebar, and search hundreds of options.",
    },
    {
      title: "Two models, picked for you",
      desc: "Simple questions stay on the fast local model; tomat routes only the hard ones to a stronger model, per message, with no manual switching.",
    },
    {
      title: "Tools you write yourself",
      desc: "Drop a tool definition and a tiny handler into a toolkit, then trigger it by prompt. Tools can pause to ask you for input before they act.",
    },
    {
      title: "Talk and listen",
      desc: "Speak your instruction and hear the reply read back, with live captions for both sides of the conversation.",
    },
  ];

  const STAGES = 5;
  const handles: (Handle | undefined)[] = Array.from(
    { length: STAGES },
    () => undefined,
  );
  let registered = 0;
  let ready = $state(false);

  let index = $state(0);
  let progress = $state(0);
  let scrolling = $state(false);
  // Active stage manually paused by clicking its cover; cleared on settle.
  let paused = $state(false);
  // Shared available frame height (set by recomputeScale); per-stage scale derives from it.
  let availH = $state(DESIGN_H * MAX_SCALE);
  let trackW = $state(0);
  // Per-stage content height (app space): chat measures on mount, settings stays APP_H.
  let contentH = $state<number[]>(Array.from({ length: STAGES }, () => APP_H));
  // Scroll position in stage units (0.5 = halfway); drives the live dim + bar morph.
  let scrollFrac = $state(0);

  // Thin gutter on phones (no peek), wide gutter on desktop (neighbours peek).
  const panelGap = $derived(
    trackW > 0 && trackW < NARROW_W ? PANEL_GAP_NARROW : PANEL_GAP_WIDE,
  );
  // Soft-fade the track edges only when neighbours peek (wide). On a phone the
  // panel fills the width with no peek, so the fade would dim the active demo's
  // own left/right edges instead of a peeking neighbour.
  const edgeFade = $derived(trackW >= NARROW_W);
  const designH = $derived(contentH.map((h) => h + 2 * APP_SHADOW));
  // Per-stage scale: fit the design box into the track width and availH, capped at
  // MAX_SCALE, so a shorter stage (chat) scales larger than a taller one (settings).
  // Also cap the visible app surface (APP_W, the frame minus its shadow margin) to
  // the caption/install-card width, so a demo never renders wider than the text and
  // install card below it; its left/right edges line up with that small content.
  // (A sub-1 scale is fine for the bubbles' frosted-blur halo, as long as no
  // ANCESTOR carries a `mask`/`filter`: that is what breaks `backdrop-filter` in
  // WebKit, which is why the track edge-fade below is an overlay, not a mask.)
  const scales = $derived(
    designH.map((dh) =>
      Math.max(
        0.2,
        Math.min(
          MAX_SCALE,
          CAPTION_W / APP_W,
          // Width is unknown until the track is measured on mount; treat it as
          // unconstrained (not the negative `-panelGap/DESIGN_W`, which would
          // clamp the whole scale to the 0.2 floor and render a collapsed frame).
          trackW > 0 ? (trackW - panelGap) / DESIGN_W : MAX_SCALE,
          availH / dh,
        ),
      ),
    ),
  );
  const frameWs = $derived(scales.map((s) => DESIGN_W * s));
  const frameHs = $derived(scales.map((s, i) => designH[i] * s));
  // Uniform footprint (widest + tallest frame) so the snap step and captions align.
  const maxFrameW = $derived(frameWs.length ? Math.max(...frameWs) : 0);
  const maxFrameH = $derived(frameHs.length ? Math.max(...frameHs) : 0);
  // Snap step: widest frame + gap, floored at the caption width and capped at the
  // track width (so a phone panel never overflows the screen).
  const panelW = $derived(
    Math.min(trackW || Infinity, Math.max(maxFrameW + panelGap, CAPTION_W)),
  );
  let sectionEl: HTMLElement | undefined = $state();
  let barEl: HTMLElement | undefined = $state();

  // Closeness of stage `i` to the current scroll centre, 0..1.
  function weight(i: number): number {
    return Math.max(0, 1 - Math.abs(scrollFrac - i));
  }

  let trackEl: HTMLElement | undefined = $state();
  // Reactive so the play effect and context recompute once onMount reads the query.
  let reduce = $state(false);
  let scrollSettleTimer = 0;

  // Shared UI context for the subtree: schema defaults, but animations collapse to 0
  // under reduced motion so previews jump to the final frame with no movement.
  const showcaseDefaults = getDefaultSettings();
  // A reactive expansion registry so a stage can collapse/expand a shared
  // Expandable bubble (e.g. the relevant-tools card) from its timeline by id.
  const expansion = new SvelteMap<string, boolean>();
  setUiContext(
    makeUiContext({
      getSetting: (key) => showcaseDefaults[key],
      animationDurationMs: (ms = BASE_MS) => (reduce ? 0 : ms),
      expansionGet: (id, fallback = false) =>
        id !== undefined ? (expansion.get(id) ?? fallback) : fallback,
      expansionSet: (id, value) => expansion.set(id, value),
      expansionInit: (id, value) => {
        if (!expansion.has(id)) expansion.set(id, value);
      },
    }),
  );

  // Advance to the next stage when the active timeline finishes (reads live `index`).
  function onComplete(): void {
    if (reduce) return;
    scrollToIndex((index + 1) % STAGES);
  }

  // A stage reports its measured content height; its derived scale updates to fit.
  function reportContentH(i: number, h: number): void {
    contentH[i] = h;
  }

  function register(i: number, h: Handle): void {
    handles[i] = h;
    h.timeline.eventCallback("onComplete", onComplete);
    if (++registered === STAGES) {
      // Lock every stage to time 0; the play effect starts the active one.
      handles.forEach((x) => x?.reset());
      ready = true;
    }
  }

  // Reveal the homepage hero once every stage has measured and registered (so the
  // layout has stopped settling). Flipping `main[data-ready]` triggers the staged
  // fade in site.css: the install button fades in, then the showcase scrim fades
  // out. All the load-time settling (scale, scroll, height) happens behind that,
  // so it is never seen as a shift.
  $effect(() => {
    if (ready) sectionEl?.closest("main")?.setAttribute("data-ready", "");
  });

  // Play the active timeline only when settled; reduced motion jumps to the end.
  $effect(() => {
    if (!ready) return;
    const tl = handles[index]?.timeline;
    if (!tl) return;
    if (reduce) {
      tl.progress(1);
      return;
    }
    if (scrolling || paused) tl.pause();
    else tl.play();
  });

  // Toggle play/pause on the active stage (clicking its own cover).
  function togglePause(): void {
    paused = !paused;
  }

  function lockAndStart(): void {
    handles.forEach((h, j) => {
      if (j !== index) h?.reset();
    });
    handles[index]?.reset();
    // The play effect resumes the active stage now that scrolling is false.
  }

  function onScroll(): void {
    if (!trackEl) return;
    scrollFrac = panelW ? trackEl.scrollLeft / panelW : 0;
    if (!scrolling) {
      scrolling = true;
      handles[index]?.timeline.pause();
    }
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = window.setTimeout(settle, 120);
  }

  function settle(): void {
    if (!trackEl) return;
    const next = Math.max(0, Math.min(STAGES - 1, Math.round(scrollFrac)));
    index = next;
    scrolling = false;
    paused = false;
    lockAndStart();
  }

  function scrollToIndex(i: number): void {
    if (!trackEl) return;
    trackEl.scrollTo({
      left: i * panelW,
      behavior: reduce ? "auto" : "smooth",
    });
  }

  // Available frame height: the main column minus its padding, the install row, the
  // bar, the tallest caption, and the inter-element gaps. A second rAF pass re-reads
  // the caption after it reflows at the new width. We never observe what we resize,
  // so this can't loop.
  function recomputeScale(pass = 0): void {
    if (!trackEl || !sectionEl) return;
    trackW = trackEl.clientWidth;

    let h = DESIGN_H * MAX_SCALE;
    const main = sectionEl.closest("main");
    if (main) {
      const cs = getComputedStyle(main);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const rowGap = parseFloat(cs.rowGap) || 0;
      // The two vertical gaps differ (section track->bar, panel frame->caption).
      const sectionGap = parseFloat(getComputedStyle(sectionEl).rowGap) || 0;
      const panel = trackEl.firstElementChild as HTMLElement | null;
      const frameCaptionGap = panel
        ? parseFloat(getComputedStyle(panel).rowGap) || 0
        : 0;
      const install = main.querySelector<HTMLElement>("[data-install]");
      const installH = install ? install.offsetHeight : 0;
      const captionH = Array.from(
        trackEl.querySelectorAll<HTMLElement>("[data-caption]"),
      ).reduce((m, el) => Math.max(m, el.offsetHeight), 0);
      const barH = barEl?.offsetHeight ?? 0;
      h =
        main.clientHeight -
        padY -
        installH -
        rowGap -
        barH -
        captionH -
        sectionGap -
        frameCaptionGap;
    }

    availH = h;
    // Keep the active stage centred after a resize changed the snap step.
    requestAnimationFrame(() => {
      if (trackEl) trackEl.scrollLeft = index * panelW;
    });
    if (pass < 1) requestAnimationFrame(() => recomputeScale(1));
  }

  onMount(() => {
    reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    recomputeScale();
    // Observe only what changes the available space (viewport via `main`, the
    // install row), NOT the track/section we resize, so scaling can't feed back.
    const ro = new ResizeObserver(() => recomputeScale());
    const main = sectionEl?.closest("main");
    if (main) ro.observe(main);
    const install = main?.querySelector("[data-install]");
    if (install) ro.observe(install);
    // Mirror the active timeline's progress onto the active bar each frame.
    const tick = () => {
      const tl = handles[index]?.timeline;
      if (tl) progress = tl.progress();
    };
    gsap.ticker.add(tick);
    return () => {
      gsap.ticker.remove(tick);
      ro.disconnect();
    };
  });
</script>

<section
  bind:this={sectionEl}
  class="showcase-section relative shrink-0 w-full flex flex-col items-center gap-4"
>
  <!-- Track + its edge fades. The fades are pointer-events-none gradient
       OVERLAYS painted in front of the track's left/right edges (fading to the
       page bg-surface), NOT a `mask` on the track: a mask on the bubbles'
       ancestor breaks their `backdrop-filter` halo in WebKit, so we paint the
       fade on top instead. They sit above the demos but below nothing they need
       to block (pointer-events-none), and only show when neighbours peek. -->
  <div class="relative w-full">
    <!-- Stage track: full-width horizontal snap-scroll, one stage per snap unit;
         neighbours peek and dim, only the centred stage animates. -->
    <div
      bind:this={trackEl}
      onscroll={onScroll}
      class="no-scrollbar w-full flex overflow-x-auto overflow-y-hidden overscroll-x-none snap-x snap-mandatory"
      style="padding-inline: max(0px, calc(50% - {panelW / 2}px))"
    >
    {#each meta as m, i (i)}
      <div
        class="relative snap-center shrink-0 flex flex-col items-center justify-end gap-6 sm:gap-10"
        style="width: {panelW}px"
      >
        <!-- Patterned focus grid belonging to this stage: capped to the content
             width and centered so it backs the demo + caption, gives the demo's
             blur borders texture to sample, and rides along with the stage as it
             scrolls. It lives inside the panel, so the panel's dim opacity fades
             it together with the rest of an off-centre stage. See
             `.focus-grid-stage` in site.css. -->
        <div class="focus-grid-stage" aria-hidden="true"></div>

        <!-- Uniform footprint; each stage's scaled design frame centres inside it. -->
        <div
          style="width: {maxFrameW}px; height: {maxFrameH}px"
          class="relative shrink-0"
        >
          <div
            class="demo-frame absolute left-1/2 top-1/2 origin-center"
            style="width: {DESIGN_W}px; height: {designH[
              i
            ]}px; transform: translate(-50%, -50%) scale({scales[i]})"
          >
            {#if i === 0}
              <ChatStage
                register={(h) => register(0, h)}
                reportHeight={(h) => reportContentH(0, h)}
              />
            {:else if i === 1}
              <SettingsStage register={(h) => register(1, h)} />
            {:else if i === 2}
              <DualModelStage
                register={(h) => register(2, h)}
                reportHeight={(h) => reportContentH(2, h)}
              />
            {:else if i === 3}
              <CustomToolStage
                register={(h) => register(3, h)}
                reportHeight={(h) => reportContentH(3, h)}
              />
            {:else}
              <SpeechStage
                register={(h) => register(4, h)}
                reportHeight={(h) => reportContentH(4, h)}
              />
            {/if}
          </div>
        </div>

        <!-- Caption rides inside the panel so it slides with its stage; capped to the
             install-card width so its left edge aligns with everything below. It
             shrink-wraps its content (no min-height), so the description is always
             the block's bottom edge with no slack. The caption text has its
             half-leading trimmed (see site.css [data-caption]), so this
             title->description gap and the section's description->bar gap are the
             SAME `gap-4` token AND read as the same visible distance. -->
        <div
          data-caption
          class="w-full max-w-xl mx-auto px-4 text-left flex flex-col gap-4"
        >
          <h2 class="text-lg font-semibold text-default-900">{m.title}</h2>
          <p class="text-sm text-default-600 text-justify">{m.desc}</p>
        </div>

        <!-- Dim overlay: fades an off-centre stage toward the page background. A
             translucent surface-colored scrim PAINTED OVER the panel (a sibling,
             pointer-events-none), NOT `opacity` on the panel: opacity < 1 on the
             bubbles' ancestor establishes a backdrop root in WebKit and kills
             their `backdrop-filter` halo. Worse, a stage born off-centre (opacity
             < 1) has its halo layer established broken and never recovers when it
             later centres, so only the first stage (born centred at opacity 1)
             kept its blur. A scrim isn't an ancestor of any bubble, so every
             stage keeps its halo at all times; the centred stage's scrim is fully
             transparent (the surface-color scrim at 1 - V composites identically
             to the old panel-at-opacity-V, so the dim look is unchanged). -->
        <div
          class="stage-dim"
          aria-hidden="true"
          style="opacity: {0.65 * (1 - weight(i))}"
        ></div>

        <!-- Cover: blocks pointer access to the demo (so the playing demo can't be
             clicked). On a side demo it focuses that stage; on the active demo it
             toggles play/pause of its animation. Transparent; the demo shows through. -->
        <button
          type="button"
          aria-label={i === index
            ? `${paused ? "Play" : "Pause"}: ${m.title}`
            : `Show: ${m.title}`}
          class="absolute inset-0 z-20 cursor-pointer"
          onclick={() => (i === index ? togglePause() : scrollToIndex(i))}
        ></button>
      </div>
    {/each}
    </div>

    <!-- Edge fades: pointer-events-none gradient overlays in front of the
         track's left/right edges (fade to bg-surface), shown only when
         neighbours peek. An overlay (not a `mask` on the track) keeps the
         bubbles' `backdrop-filter` halo intact. -->
    {#if edgeFade}
      <div class="edge-fade-overlay edge-fade-overlay-left" aria-hidden="true"></div>
      <div class="edge-fade-overlay edge-fade-overlay-right" aria-hidden="true"></div>
    {/if}
  </div>

  <!-- Playback indicator, one segment per stage: the centred stage is a progress
       bar, the others dots; scrolling morphs between them. While scrolling, each
       segment's track adopts the growing-fill colour (bg-default-400) so the
       progress vanishes into its own background; it reverts on settle. -->
  <div bind:this={barEl} class="shrink-0 w-full max-w-xl mx-auto px-4">
    <div class="flex items-center gap-1">
      {#each meta as m, i (i)}
        <button
          type="button"
          onclick={() => scrollToIndex(i)}
          title={m.title}
          aria-label={m.title}
          class="relative h-1.5 rounded-full overflow-hidden hover:cursor-pointer transition-colors duration-200 {scrolling
            ? 'bg-default-400'
            : 'bg-surface-inset'}"
          style="flex-grow: {weight(
            i,
          )}; flex-basis: 0.375rem; min-width: 0.375rem"
        >
          <div
            class="absolute inset-y-0 left-0 bg-default-400 rounded-full transition-opacity duration-300"
            style="width: {progress * 100}%; opacity: {i === index ? 1 : 0}"
          ></div>
        </button>
      {/each}
    </div>
  </div>

  <!-- Reveal scrim: a surface-colored cover painted OVER the whole showcase that
       fades OUT once the layout has settled (driven by the critical `data-js` /
       `main[data-ready]` gate in BaseLayout's <head>). It is a fade, but never
       `opacity` on the section itself: opacity < 1 on a bubble ancestor kills its
       `backdrop-filter` halo in WebKit (same reason the dim/edge fades are
       overlays, not masks). A sibling scrim is not a bubble ancestor, so the
       halos survive. All its styling lives in the critical head CSS so it covers
       on the very first paint, before the UnoCSS utilities load. -->
  <div class="showcase-scrim" aria-hidden="true"></div>
</section>

<style>
  /* The shared chat/settings components cap their widths to the app window via
     `100vw`. In the demo the viewport is the browser, not that fixed window, so
     re-pin the caps to the window width (700px) inside the frame for a 1:1 render.
     Scoped to `.demo-frame` so real bubbles elsewhere on the site keep the live cap. */
  :global(.demo-frame .bubble-body) {
    max-width: calc(700px - 5rem);
  }
  :global(.demo-frame .max-w-\[calc\(100vw-135px\)\]) {
    max-width: calc(700px - 135px);
  }
  :global(.demo-frame .max-w-\[calc\(100vw-80px\)\]) {
    max-width: calc(700px - 80px);
  }
</style>
