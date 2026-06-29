<script lang="ts">
  import { onMount } from "svelte";
  import gsap from "gsap";
  import { getDefaultSettings, SETTINGS_SCHEMA } from "@tomat/shared/domain/settings/engine";
  import SettingsShellView from "@tomat/shared/ui/components/settings/SettingsShellView.svelte";
  import SettingsContentView from "@tomat/shared/ui/components/settings/SettingsContentView.svelte";
  import DownloadsModalView from "@tomat/shared/ui/components/settings/DownloadsModalView.svelte";
  import SettingsDemoFooter from "../demos/SettingsDemoFooter.svelte";
  import Cursor from "./Cursor.svelte";
  import { Demo, type Timeline } from "../../lib/showcase";

  let { register }: { register: (h: { timeline: Timeline; reset: () => void }) => void } = $props();

  const D = getDefaultSettings();
  const groups = SETTINGS_SCHEMA.filter((g) => !g.hidden).map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    iconInactive: g.iconInactive ?? g.icon,
  }));

  type Shell = { reset: () => void };
  let shell = $state<Shell>();
  let selectedGroupId = $state("llm");

  // The required files for the chosen model, listed with their sizes and
  // downloaded on approval. A model weight downloads first, then the runtime.
  type Row = {
    key: string;
    status: string;
    icon: string;
    filename: string;
    title: string;
    sizeText: string;
    progress: number;
    showReveal?: boolean;
  };
  const MODEL_GB = 4.7;
  function freshItems(): Row[] {
    return [
      {
        key: "model",
        status: "Downloading",
        icon: "i-material-symbols-psychology-rounded",
        filename: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        title: "Qwen2.5-7B-Instruct-Q4_K_M.gguf (models/Qwen2.5-7B-Instruct-Q4_K_M.gguf)",
        sizeText: `0.9 GB / ${MODEL_GB} GB`,
        progress: 18,
      },
      {
        key: "runtime",
        status: "Pending",
        icon: "i-material-symbols-download-rounded",
        filename: "llama-server",
        title: "llama-server (binaries/llama-server)",
        sizeText: "12 MB",
        progress: 0,
      },
    ];
  }
  let items = $state<Row[]>(freshItems());
  let modalOpen = $state(false);
  const hasCompleted = $derived(items.some((r) => r.status === "Completed"));

  // The sidebar Downloads row mirrors the client's running DownloadsButton: the
  // animated loop icon + a neutral ping that blinks while a download is active.
  let footerRunning = $state(true);
  let footerBlink = $state(false);

  let stageEl: HTMLElement | undefined = $state();
  let cursorRef: HTMLElement | undefined = $state();

  function setModelProgress(pct: number): void {
    const p = Math.round(pct);
    const gb = ((p / 100) * MODEL_GB).toFixed(1);
    items = items.map((r) =>
      r.key === "model" ? { ...r, progress: p, sizeText: `${gb} GB / ${MODEL_GB} GB` } : r,
    );
  }
  function completeModel(): void {
    items = items.map((r) =>
      r.key === "model"
        ? { ...r, progress: 100, status: "Completed", sizeText: `${MODEL_GB} GB`, showReveal: true }
        : r.key === "runtime"
          ? { ...r, status: "Downloading" }
          : r,
    );
  }
  function completeRuntime(): void {
    items = items.map((r) =>
      r.key === "runtime" ? { ...r, progress: 100, status: "Completed", showReveal: true } : r,
    );
  }

  function reset(): void {
    items = freshItems();
    modalOpen = false;
    footerRunning = true;
    shell?.reset();
    selectedGroupId = "llm";
  }

  onMount(() => {
    if (!stageEl || !cursorRef) return;
    const demo = new Demo(cursorRef, stageEl);
    demo.placeFrac(0.5, 0.5);

    // Blink the sidebar download ping (the client uses a 500ms useBlink toggle).
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const blinkTl = gsap.timeline({ repeat: -1, paused: reduce });
    blinkTl.call(() => (footerBlink = !footerBlink)).to({}, { duration: 0.5 });

    const tl = gsap.timeline({ paused: true });

    // 1. Open the Downloads panel from the sidebar footer.
    demo.move(tl, '[aria-label="Downloads"]', { duration: 0.9 });
    demo.hover(tl, '[aria-label="Downloads"]', true);
    demo.click(tl, '[aria-label="Downloads"]', () => (modalOpen = true));
    demo.hover(tl, '[aria-label="Downloads"]', false);
    demo.hold(tl, 0.5);

    // 2. The model weight downloads.
    const p = { v: 18 };
    tl.to(p, {
      v: 100,
      duration: 3.0,
      ease: "none",
      onUpdate: () => setModelProgress(p.v),
    });
    tl.add(() => completeModel());
    demo.hold(tl, 0.4);

    // 3. The runtime binary follows.
    const q = { v: 0 };
    tl.to(q, {
      v: 100,
      duration: 1.2,
      ease: "none",
      onUpdate: () =>
        (items = items.map((r) => (r.key === "runtime" ? { ...r, progress: Math.round(q.v) } : r))),
    });
    tl.add(() => completeRuntime());
    // Both files done: the sidebar row returns to its idle Downloads state.
    tl.add(() => (footerRunning = false));

    register({
      timeline: tl,
      reset: () => {
        reset();
        tl.pause(0);
        demo.blur();
        demo.placeFrac(0.5, 0.5);
      },
    });
    return () => {
      tl.kill();
      blinkTl.kill();
    };
  });
</script>

{#snippet sidebarFooter(collapsed: boolean)}
  <SettingsDemoFooter {collapsed} downloading={footerRunning} blink={footerBlink} />
{/snippet}

<div
  bind:this={stageEl}
  class="relative w-full h-full overflow-hidden flex items-center justify-center"
>
  <!-- The panel sits in its own positioned box so the (absolute) downloads modal
       overlays just the settings panel, not the whole page. -->
  <div class="relative shrink-0 w-[620px] h-[960px]">
    <SettingsShellView
      bind:this={shell}
      {groups}
      bind:selectedGroupId
      sizeClass="w-[620px] h-[960px]"
      {sidebarFooter}
    >
      {#snippet groupContent(gid)}
        <SettingsContentView groupId={gid} values={D} />
      {/snippet}
    </SettingsShellView>
    <DownloadsModalView
      open={modalOpen}
      {items}
      {hasCompleted}
      onClose={() => (modalOpen = false)}
    />
  </div>
  <Cursor bind:ref={cursorRef} />
</div>
