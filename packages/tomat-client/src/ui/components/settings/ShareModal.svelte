<script lang="ts">
  // Settings share popup: Export curates a JSON of non-default values for the
  // selected groups/sections/fields; Import pastes that JSON and applies the
  // chosen keys. Both drive the same ShareTree. Overwrites are signalled
  // inline (warning rows) and in the Import button text rather than a modal.
  // The modal keeps a constant height: the tree explorer is the scrolling
  // region, and the tab body slides horizontally on tab change (mirroring the
  // settings group-tab animation).
  import { tick } from "svelte";
  import { getDefaultSettings } from "@tomat/shared";
  import { settingsState } from "../../state";
  import { CSS_EASING, getDuration } from "$lib/appearance/animations";
  import { getLogger } from "$lib/util/log";
  import Modal from "@tomat/shared/ui/components/primitives/Modal.svelte";
  import Button from "@tomat/shared/ui/components/primitives/Button.svelte";
  import IconButton from "@tomat/shared/ui/components/primitives/IconButton.svelte";
  import Alert from "@tomat/shared/ui/components/primitives/Alert.svelte";
  import Textarea from "@tomat/shared/ui/components/primitives/Textarea.svelte";
  import SettingsTabs from "@tomat/shared/ui/components/primitives/Tabs.svelte";
  import ShareTree from "./ShareTree.svelte";
  import {
    buildTree,
    classifyImport,
    computeExportJson,
    EXPORTABLE_FIELD_IDS,
    parseImport,
  } from "$lib/settings/share";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  const log = getLogger("settings-share");
  const defaults = getDefaultSettings();

  type TabId = "import" | "export";
  const tabs = [
    { id: "import", label: "Import" },
    { id: "export", label: "Export" },
  ];

  // `activeTab` drives the knob (moves immediately); `contentTab` is the body
  // actually rendered, swapped at the slide's midpoint while it's offscreen.
  let activeTab = $state<TabId>("export");
  let contentTab = $state<TabId>("export");
  let tabLayerEl = $state<HTMLDivElement>();
  let tabTransitioning = false;
  const tabSlideMs = $derived(getDuration() * 2);
  const animationsEnabled = $derived(
    !!settingsState.currentSettings["appearance.animationsEnabled"],
  );

  async function selectTab(id: string): Promise<void> {
    const target = id as TabId;
    if (target === activeTab || tabTransitioning) return;
    const toIdx = tabs.findIndex((t) => t.id === target);
    const fromIdx = tabs.findIndex((t) => t.id === activeTab);
    const dur = getDuration();
    activeTab = target;
    const swap = () => (contentTab = target);
    if (!tabLayerEl || dur <= 0) {
      swap();
      return;
    }
    tabTransitioning = true;
    // Later tab -> current leaves left, new enters from the right; earlier tab
    // reverses it.
    const outSign = toIdx > fromIdx ? -1 : 1;
    const trans = `transform ${dur}ms ${CSS_EASING}`;
    tabLayerEl.style.transition = trans;
    tabLayerEl.style.transform = `translateX(${100 * outSign}%)`;
    await new Promise((r) => setTimeout(r, dur));

    swap();
    await tick();
    tabLayerEl.style.transition = "none";
    tabLayerEl.style.transform = `translateX(${100 * -outSign}%)`;
    void tabLayerEl.offsetHeight;

    tabLayerEl.style.transition = trans;
    tabLayerEl.style.transform = "";
    await new Promise((r) => setTimeout(r, dur));
    tabLayerEl.style.transition = "";
    tabTransitioning = false;
  }

  // --- export ---------------------------------------------------------------
  const exportTree = buildTree(EXPORTABLE_FIELD_IDS);
  let exportSelected = $state<Set<string>>(new Set());
  const exportJson = $derived(
    computeExportJson(exportSelected, settingsState.currentSettings, defaults),
  );
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportJson);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch (e) {
      log.warn("copy failed:", e);
    }
  }

  // --- import ---------------------------------------------------------------
  let importText = $state("");
  let importing = $state(false);
  let importError = $state<string | null>(null);
  let importSelected = $state<Set<string>>(new Set());

  const parsed = $derived(parseImport(importText));
  function importKind(id: string) {
    return classifyImport(parsed.values[id], settingsState.currentSettings[id], defaults[id]);
  }

  const importTree = $derived(
    buildTree(
      new Set(Object.keys(parsed.values)),
      (id) => importKind(id) === "overwrite",
      (id) => importKind(id) === "noop",
    ),
  );

  // Default to selecting every applicable key in the pasted JSON (skipping the
  // no-ops, which aren't selectable); reset on every change.
  $effect(() => {
    const next = new Set<string>();
    for (const id of Object.keys(parsed.values)) {
      if (importKind(id) !== "noop") next.add(id);
    }
    importSelected = next;
  });

  const counts = $derived.by(() => {
    let apply = 0;
    let overwrite = 0;
    for (const id of importSelected) {
      const kind = importKind(id);
      if (kind === "apply") apply++;
      else if (kind === "overwrite") overwrite++;
    }
    return { apply, overwrite };
  });

  function plural(n: number): string {
    return `${n} Setting${n === 1 ? "" : "s"}`;
  }

  const importLabel = $derived.by(() => {
    const { apply, overwrite } = counts;
    if (apply > 0 && overwrite > 0) return `Apply ${plural(apply)} and Overwrite ${plural(overwrite)}`;
    if (overwrite > 0) return `Overwrite ${plural(overwrite)}`;
    return `Apply ${plural(apply)}`;
  });

  // Output only exists once a selection yields non-default values; the tree only
  // exists once the pasted JSON has importable keys. When the paired textarea
  // and tree are both present they each take half the height (flex-1); when one
  // is absent the other fills.
  const exportHasOutput = $derived(exportJson !== "{}");
  const importHasTree = $derived(Object.keys(parsed.values).length > 0);
  const importCanApply = $derived(counts.apply + counts.overwrite > 0);

  async function pasteImport() {
    try {
      importText = await navigator.clipboard.readText();
    } catch (e) {
      log.warn("paste failed:", e);
    }
  }

  async function doImport() {
    const updates: Record<string, unknown> = {};
    for (const id of importSelected) {
      if (importKind(id) !== "noop") updates[id] = parsed.values[id];
    }
    if (Object.keys(updates).length === 0) return;
    importing = true;
    importError = null;
    try {
      await settingsState.updateSettings(updates);
      onClose();
    } catch (e) {
      log.warn("import failed:", e);
      importError = "Failed to apply settings.";
    } finally {
      importing = false;
    }
  }

</script>

{#snippet floatButton(icon: string, title: string, onclick: () => void)}
  <IconButton
    {icon}
    {title}
    size="lg"
    surface="none"
    rounded="rounded-full"
    class="absolute top-2 right-2 z-1 bg-surface-inset hover:bg-surface shadow-sm"
    {onclick}
  />
{/snippet}

{#snippet exportPanel()}
  <p class="text-default-600 text-sm shrink-0">
    Choose which settings to export. Only values you have changed from their defaults are included.
  </p>
  <div class="flex-1 min-h-0 overflow-y-auto tomat-scroll pr-1">
    <ShareTree nodes={exportTree} bind:selected={exportSelected} />
  </div>
  {#if exportHasOutput}
    <div class="relative flex-1 min-h-0">
      <Textarea
        value={exportJson}
        disabled
        mono
        autoResize="none"
        ariaLabel="Exported settings JSON"
        class="h-full w-full overflow-y-auto resize-none tomat-scroll"
      />
      {@render floatButton(
        copied
          ? "i-material-symbols-check-rounded"
          : "i-material-symbols-content-copy-outline-rounded",
        "Copy to clipboard",
        copyExport,
      )}
    </div>
  {/if}
{/snippet}

{#snippet importPanel()}
  <p class="text-default-600 text-sm shrink-0">
    Paste exported settings, then choose which to apply. Highlighted rows will overwrite values you
    have customized.
  </p>
  <div class="relative flex-1 min-h-0">
    <!-- A native textarea (not the Textarea component) so its single bind:value
         keeps the caret in place during manual edits; routing the value through
         a component's prop round-trips it and bounces the caret to the end. -->
    <textarea
      bind:value={importText}
      spellcheck="false"
      aria-label="Settings JSON to import"
      class="h-full w-full resize-none overflow-y-auto tomat-scroll rounded-medium px-2 py-1.5 text-sm font-mono text-default-800 outline-none {parsed.error
        ? 'bg-accent-red-300 border-accent-red-400'
        : 'bg-surface-inset focus:ring-blue-500'}"
    ></textarea>
    {@render floatButton(
      "i-material-symbols-content-paste-rounded",
      "Paste from clipboard",
      pasteImport,
    )}
  </div>

  {#if parsed.error}
    <Alert variant="error" size="sm" class="shrink-0">{parsed.error}</Alert>
  {:else if parsed.unknownKeys.length > 0}
    <Alert variant="warning" size="sm" class="shrink-0">
      Ignoring {parsed.unknownKeys.length} unrecognized or unsupported key{parsed.unknownKeys
        .length === 1
        ? ""
        : "s"}.
    </Alert>
  {/if}
  {#if importError}
    <Alert variant="error" size="sm" class="shrink-0">{importError}</Alert>
  {/if}

  {#if importHasTree}
    <div class="flex-1 min-h-0 overflow-y-auto tomat-scroll pr-1">
      <ShareTree nodes={importTree} bind:selected={importSelected} />
    </div>
  {/if}

  {#if importHasTree}
    <Button
      variant="primary"
      loading={importing}
      disabled={!importCanApply}
      icon="i-material-symbols-check-rounded"
      onclick={doImport}
      class="w-full px-4 py-2.5 rounded-large text-center whitespace-normal shrink-0"
    >
      {importCanApply ? importLabel : "Nothing to Apply"}
    </Button>
  {/if}
{/snippet}

<Modal
  {open}
  onclose={onClose}
  maxWidth="lg"
  ariaLabel="Import or export settings"
  class="h-[70vh] max-h-[40rem]"
>
  <div class="flex items-center justify-between shrink-0">
    <div class="text-default-800 font-medium">Import / Export Settings</div>
    <IconButton
      icon="i-material-symbols-close-rounded"
      title="Close"
      ariaLabel="Close"
      surface="circle"
      variant="subtle"
      size="md"
      class="hover:bg-default-400"
      onclick={onClose}
    />
  </div>

  <div class="shrink-0">
    <SettingsTabs {tabs} active={activeTab} onSelect={selectTab} slideMs={tabSlideMs} />
  </div>

  <!-- overflow-x clip contains the offscreen layer during the slide so the
       modal never grows a horizontal scrollbar; the y axis stays visible for
       the tree's own scroll. -->
  <div class="relative flex-1 min-h-0 flex flex-col" style:overflow-x="clip">
    <div
      bind:this={tabLayerEl}
      class="flex-1 min-h-0 flex flex-col gap-3"
      class:will-change-transform={animationsEnabled}
    >
      {#if contentTab === "export"}
        {@render exportPanel()}
      {:else}
        {@render importPanel()}
      {/if}
    </div>
  </div>
</Modal>
