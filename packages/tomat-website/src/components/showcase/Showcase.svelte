<script lang="ts">
  import { onMount } from "svelte";
  import gsap from "gsap";
  import ChatStage from "./ChatStage.svelte";
  import SettingsStage from "./SettingsStage.svelte";
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
  ];

  const STAGES = 2;
  const handles: (Handle | undefined)[] = Array.from(
    { length: STAGES },
    () => undefined,
  );
  let registered = 0;
  let ready = $state(false);

  let index = $state(0);
  let progress = $state(0);
  let scrolling = $state(false);
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
  const designH = $derived(contentH.map((h) => h + 2 * APP_SHADOW));
  // Per-stage scale: fit the design box into the track width and availH, capped at
  // MAX_SCALE, so a shorter stage (chat) scales larger than a taller one (settings).
  const scales = $derived(
    designH.map((dh) =>
      Math.max(
        0.2,
        Math.min(MAX_SCALE, (trackW - panelGap) / DESIGN_W, availH / dh),
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
  // Side padding so the first and last stage can still centre in the track.
  const sidePad = $derived(Math.max(0, (trackW - panelW) / 2));

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
  setUiContext(
    makeUiContext({
      getSetting: (key) => showcaseDefaults[key],
      animationDurationMs: (ms = BASE_MS) => (reduce ? 0 : ms),
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

  // Play the active timeline only when settled; reduced motion jumps to the end.
  $effect(() => {
    if (!ready) return;
    const tl = handles[index]?.timeline;
    if (!tl) return;
    if (reduce) {
      tl.progress(1);
      return;
    }
    if (scrolling) tl.pause();
    else tl.play();
  });

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
  class="shrink-0 w-full flex flex-col items-center gap-1"
>
  <!-- Stage track: full-width horizontal snap-scroll, one stage per snap unit;
       neighbours peek and dim, only the centred stage animates. -->
  <div
    bind:this={trackEl}
    onscroll={onScroll}
    class="no-scrollbar w-full flex overflow-x-auto overscroll-x-none snap-x snap-mandatory"
    style="padding-inline: {sidePad}px"
  >
    {#each meta as m, i (i)}
      <div
        class="snap-center shrink-0 flex flex-col items-center justify-end gap-6 sm:gap-10 transition-opacity duration-200"
        style="width: {panelW}px; opacity: {0.35 + 0.65 * weight(i)}"
      >
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
            {:else}
              <SettingsStage register={(h) => register(1, h)} />
            {/if}
          </div>
        </div>

        <!-- Caption rides inside the panel so it slides with its stage; capped to the
             install-card width so its left edge aligns with everything below. -->
        <div
          data-caption
          class="w-full max-w-xl mx-auto px-4 min-h-[3.5rem] text-left"
        >
          <h2 class="text-lg font-semibold text-default-900">{m.title}</h2>
          <p class="mt-1 text-sm text-default-600 text-justify">{m.desc}</p>
        </div>
      </div>
    {/each}
  </div>

  <!-- Playback indicator, one segment per stage: the centred stage is a progress
       bar, the others dots; scrolling morphs between them. -->
  <div bind:this={barEl} class="shrink-0 w-full max-w-xl mx-auto px-4">
    <div class="flex items-center gap-1">
      {#each meta as m, i (i)}
        <button
          type="button"
          onclick={() => scrollToIndex(i)}
          title={m.title}
          aria-label={m.title}
          class="relative h-1.5 rounded-full overflow-hidden hover:cursor-pointer bg-surface-inset"
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
