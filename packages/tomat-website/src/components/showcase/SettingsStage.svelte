<script lang="ts">
  import { onMount } from "svelte";
  import gsap from "gsap";
  import { getDefaultSettings, SETTINGS_SCHEMA } from "@tomat/shared/domain/settings/engine";
  import SettingsShellView from "@tomat/shared/ui/components/settings/SettingsShellView.svelte";
  import SettingsContentView from "@tomat/shared/ui/components/settings/SettingsContentView.svelte";
  import SettingsDemoFooter from "../demos/SettingsDemoFooter.svelte";
  import Cursor from "./Cursor.svelte";
  import { Demo, type Timeline } from "../../lib/showcase";

  let { register }: { register: (h: { timeline: Timeline; reset: () => void }) => void } = $props();

  // The real settings groups (sidebar order, names, outline icons) straight from
  // the schema; hidden groups (e.g. cores) are omitted, exactly as in the app.
  const D = getDefaultSettings();
  const groups = SETTINGS_SCHEMA.filter((g) => !g.hidden).map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    iconInactive: g.iconInactive ?? g.icon,
  }));

  // Structural ref to the shell's exported methods (avoids Svelte component-type
  // friction for the bound instance).
  type Shell = {
    selectGroup: (id: string) => void;
    setSearch: (active: boolean) => void;
    getScrollEl: () => HTMLElement | undefined;
    reset: () => void;
  };
  let shell = $state<Shell>();
  let sidebarCollapsed = $state(false);
  let searchValue = $state("");

  let stageEl: HTMLElement | undefined = $state();
  let cursorRef: HTMLElement | undefined = $state();

  // The client renders its settings panel at a FIXED size (window is a
  // non-resizable 700x1200): `w-[760px] max-w-[calc(100vw-5rem)] h-80vh` -> width
  // clamps to 700-5rem=620 (= APP_W), height is 0.8*1200=960 (= APP_H). We render
  // the real shell at exactly that size (every control/font/gap matches the app
  // 1:1); the showcase frame is sized to it and scaled as a whole. The literal
  // `sizeClass` below MUST equal APP_W x APP_H (UnoCSS only generates arbitrary
  // values from literal class strings, not interpolated ones).

  function reset(): void {
    // Synchronous: instantly restore the initial state (no slide/collapse
    // animation on re-entry). sidebarCollapsed flips back here while the stage is
    // still off-screen during a lock, so its label expansion is not seen.
    sidebarCollapsed = false;
    searchValue = "";
    shell?.reset();
  }

  onMount(() => {
    if (!stageEl || !cursorRef) return;
    const demo = new Demo(cursorRef, stageEl);
    demo.placeFrac(0.5, 0.5);

    const tl = gsap.timeline({ paused: true });

    // 1. Switch to Appearance.
    demo.move(tl, ".settings-group-appearance", { duration: 0.9 });
    demo.hover(tl, ".settings-group-appearance", true);
    demo.click(tl, ".settings-group-appearance", () => shell?.selectGroup("appearance"));
    demo.hover(tl, ".settings-group-appearance", false);
    demo.hold(tl, 0.7);

    // 2. Collapse the sidebar.
    demo.move(tl, '[data-demo="collapse"]', { duration: 0.8 });
    demo.hover(tl, '[data-demo="collapse"]', true);
    demo.click(tl, '[data-demo="collapse"]', () => (sidebarCollapsed = true));
    demo.hover(tl, '[data-demo="collapse"]', false);
    demo.hold(tl, 0.5);

    // 3. Scroll the field list.
    demo.move(tl, '[data-demo="content"]', { duration: 0.7 });
    demo.scroll(tl, () => shell?.getScrollEl(), 240, { duration: 2.3 });
    demo.hold(tl, 0.3);

    // 4. Search "color".
    demo.move(tl, 'input[aria-label="Search settings"]', { duration: 0.8 });
    demo.click(tl, 'input[aria-label="Search settings"]');
    demo.type(
      tl,
      (v) => {
        searchValue = v;
        if (v.trim()) shell?.setSearch(true);
      },
      "color",
      { duration: 1.3 },
    );
    demo.hold(tl, 0.7);

    // 5. Scroll the results.
    demo.scroll(tl, () => shell?.getScrollEl(), 160, { duration: 2.0 });
    demo.hold(tl, 1.3);
    // Drop the caret left in the search field before the loop auto-advances, so a
    // focused off-screen input can't fight the track's scroll to the next stage.
    tl.add(() => demo.blur());

    register({
      timeline: tl,
      reset: () => {
        reset();
        // pause(0) seeks to the start with suppressEvents (default), so resetting
        // does not re-fire the timeline's action callbacks.
        tl.pause(0);
        demo.blur();
        demo.placeFrac(0.5, 0.5);
      },
    });
    return () => tl.kill();
  });
</script>

{#snippet searchResults()}
  <SettingsContentView searchQuery="color" values={D} />
{/snippet}

<!-- The app's sidebar footer (Downloads + the "tomat Client vX.Y.Z" version row),
     the same single static copy the manual demos render. -->
{#snippet sidebarFooter(collapsed: boolean)}
  <SettingsDemoFooter {collapsed} />
{/snippet}

<div bind:this={stageEl} class="relative w-full h-full overflow-hidden flex items-center justify-center">
  <!-- The shell renders at the app's exact panel size (APP_W x APP_H = 620x960),
       so every control/font/gap is 1:1 with the client; the showcase frame is
       sized to it and scaled as a whole. The Cursor is a sibling of the panel (not
       nested in it) so its coordinates stay in the stage's space; Demo.center()
       reads on-screen rects, so it still targets controls correctly. -->
  <div class="shrink-0">
    <SettingsShellView
      bind:this={shell}
      {groups}
      bind:sidebarCollapsed
      bind:searchValue
      sizeClass="w-[620px] h-[960px]"
      searchContent={searchResults}
      {sidebarFooter}
    >
      {#snippet groupContent(gid)}
        <SettingsContentView groupId={gid} values={D} />
      {/snippet}
    </SettingsShellView>
  </div>
  <Cursor bind:ref={cursorRef} />
</div>
