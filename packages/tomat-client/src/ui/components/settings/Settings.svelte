<script lang="ts">
  import { onMount, tick } from "svelte";
  import { platform } from "$lib/platform";
  import { isTauri } from "$lib/util/env";
  import { CSS_EASING, getDuration } from "$lib/appearance/animations";
  import { groupDestinations, SETTINGS_SCHEMA } from "@tomat/shared";
  import type { SettingField, SettingSection } from "@tomat/shared";
  import type { Monitor } from "$lib/util/types";
  import { hasAlpha } from "$lib/appearance/color";
  import { getLogger } from "$lib/util/log";

  const log = getLogger("settings");

  // Sidecar (re)starts are server-side now: PATCH /api/v1/settings triggers
  // core to spawn / restart its sidecars based on the new config. The UI
  // doesn't need to call anything explicit anymore.
  async function startConfiguredServices(): Promise<void> {
    /* no-op: handled server-side */
  }
  import Bubble from "../ui/Bubble.svelte";
  import DestinationChip from "../ui/DestinationChip.svelte";
  import HelpText from "../ui/HelpText.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import SearchInput from "../ui/SearchInput.svelte";
  import SectionHeader from "../ui/SectionHeader.svelte";
  import { settingsState, serversState, downloadsState, viewState } from "../../state";
  import { confirmState } from "$stores/confirm.svelte";
  import { connectionState } from "$stores/connection.svelte";
  import {
    evalCondition,
    isGroupVisible,
    isSectionVisible,
    defaultExpandedSections,
    searchFields,
  } from "@tomat/shared";
  import { useSettingsForm } from "$composables/use-settings-form.svelte";
  import { useSettingsSearch } from "$composables/use-settings-search.svelte";
  import { useSettingsScroll } from "$composables/use-settings-scroll.svelte";
  import { useResponsiveLayout } from "$composables/use-responsive-layout.svelte";

  // Sub-components
  import SettingsSidebar from "./SettingsSidebar.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsField from "./SettingsField.svelte";
  import SettingsTabs from "./SettingsTabs.svelte";
  import ColorPickerModal from "./ColorPickerModal.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import DownloadsModal from "./DownloadsModal.svelte";
  import DeletionsModal from "./DeletionsModal.svelte";
  import ShareModal from "./ShareModal.svelte";

  let monitors: Monitor[] = $state([]);
  let shareOpen = $state(false);
  let fonts: string[] = $state([]);
  let expandedSections = $state<Set<string>>(new Set());
  // Group-description visibility, rendered under the group header. Starts at the
  // group's tier default ("always" => open, "ondemand" => collapsed) and resets
  // on group change (the effect below); the header's info button toggles it.
  let groupDescOpen = $state(false);
  // Tabbed groups track two ids (empty for untabbed groups), both reset to the
  // first tab on group switch (the effect below):
  //  - activeTabId: the selected tab (knob + aria), updated immediately on click
  //    so the knob slides across the whole animation.
  //  - contentTabId: the tab whose body is shown, swapped mid-slide so the
  //    outgoing content is still the old tab while it slides away.
  let activeTabId = $state("");
  let contentTabId = $state("");

  // Multi-core "editing settings for" picker: lists every paired core; when
  // changed, re-selects that core so cores().api() / core-side settings load
  // from / save to the right place.
  import { cores } from "$lib/core";
  import type { PairedCoreEntry } from "$lib/core";
  let pairedCores: PairedCoreEntry[] = $state([]);
  let selectedCoreId: string = $state("");

  async function loadPairedCores() {
    try {
      pairedCores = await cores().list();
      selectedCoreId = cores().currentEntry()?.id ?? "";
    } catch {
      /* not paired yet */
    }
  }

  async function onSelectedCoreChanged(): Promise<void> {
    if (!selectedCoreId) return;
    try {
      await cores().select(selectedCoreId);
    } catch (e) {
      log.warn("select core failed:", e);
    }
  }
  const search = useSettingsSearch();
  const scroll = useSettingsScroll();
  const layout = useResponsiveLayout();
  // Shared field-change engine (validation / optimistic apply / preset flip).
  // Its hook reacts to section `expandWhen` deps by mutating this panel's
  // expanded-sections set.
  const form = useSettingsForm((sectionKey, expand) => {
    const next = new Set(expandedSections);
    if (expand) next.add(sectionKey);
    else next.delete(sectionKey);
    expandedSections = next;
  });

  // The single group whose sections are shown on the right. Switching it plays
  // the layer slide (see selectGroup); the sidebar reflects it as active.
  let selectedGroupId = $state(SETTINGS_SCHEMA[0].id);
  // Scroll-viewport height; sizes the group to at least full height so the
  // slide animation travels the whole panel.
  let viewportHeight = $state(0);

  const visibleGroups = $derived(SETTINGS_SCHEMA.filter((g) => isGroupVisible(g)));
  // The one group rendered on the right (sectioned view); undefined only if the
  // selected id somehow isn't visible.
  const selectedGroup = $derived(
    visibleGroups.find((g) => g.id === selectedGroupId),
  );
  // Reset the description toggle to the active group's tier default on switch.
  // Reads selectedGroup (not groupDescOpen), so user toggles don't re-trigger it.
  $effect(() => {
    const g = selectedGroup;
    groupDescOpen = !!g?.description && (g.descriptionTier ?? "ondemand") === "always";
    const first = g?.tabs?.[0]?.id ?? "";
    activeTabId = first;
    contentTabId = first;
  });

  // The sections the shown tab body holds. Untabbed groups expose all sections,
  // exactly as before.
  const activeSections = $derived(
    selectedGroup
      ? selectedGroup.tabs
        ? selectedGroup.sections.filter((s) => s.tab === contentTabId)
        : selectedGroup.sections
      : [],
  );

  // Knob travels for the whole tab slide (out + in = two base units).
  const tabSlideMs = $derived(getDuration() * 2);

  // The tab content layer (just the body below the tab selector), slid
  // horizontally on tab change. Mirrors the group-change vertical slide
  // (use-settings-search slideSwap) on the X axis: the active tab leaves toward
  // the side it sits on relative to the incoming one, the body swaps offscreen,
  // then the new content slides in from the opposite side.
  let tabLayerEl: HTMLDivElement | undefined = $state();
  let tabTransitioning = false;

  async function selectTab(id: string): Promise<void> {
    if (id === activeTabId || tabTransitioning) return;
    const tabs = selectedGroup?.tabs ?? [];
    const toIdx = tabs.findIndex((t) => t.id === id);
    const fromIdx = tabs.findIndex((t) => t.id === activeTabId);
    const dur = getDuration();
    // Move the knob (and the selection) now, so it slides the whole animation.
    // The body swaps at the midpoint, while it's offscreen.
    activeTabId = id;
    const swap = () => {
      contentTabId = id;
      if (scroll.scrollEl) scroll.scrollEl.scrollTop = 0;
    };
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

  // An object_management view is a single section holding a single
  // object_management field. It owns the full panel height (its own internal
  // vertical scroll), so it bypasses the normal min-height section stack and
  // renders in a definite-height flex child instead. Passed the active tab's
  // sections (or the whole group's, untabbed); sibling hidden-only flag
  // sections (e.g. toolkits.skipRiskyGrantWarning) are ignored here and render
  // nothing, but stay registered for persistence via the flat-sections walk.
  function objectManagementFieldOf(sections: SettingSection[]): SettingField | null {
    const omSections = sections.filter((s) =>
      s.fields.some((f) => f.type === "object_management")
    );
    if (omSections.length !== 1 || omSections[0].fields.length !== 1) return null;
    return omSections[0].fields[0];
  }

  // Track the user's horizontal-mode threshold setting.
  $effect(() => {
    layout.threshold =
      (settingsState.currentSettings[
        "appearance.settings.horizontalThreshold"
      ] as number) ?? 680;
  });

  const animationsEnabled = $derived(
    !!settingsState.currentSettings["appearance.animationsEnabled"],
  );

  // When reconnecting, a purely-core group's fields can't be edited (the writes
  // would fail). `inert` blocks all pointer/focus interaction for every nested
  // field at once; pair with dimming for the visual cue. A multi-destination
  // group (usage) is NOT locked: its client half stays usable, and its core
  // half shows its own loading/error state.
  const coreGroupLocked = $derived(
    connectionState.reconnecting &&
      !!selectedGroup &&
      groupDestinations(selectedGroup).length === 1 &&
      groupDestinations(selectedGroup)[0] === "core",
  );

  async function selectGroup(groupId: string) {
    // Re-clicking the active group (when not searching) restores its sections'
    // default expand/collapse state instead of replaying the slide.
    if (!search.mode && selectedGroupId === groupId) {
      withScrollAnchor(() => resetGroupToDefault(groupId));
      return;
    }
    // Search lives "above" group 0 (index -1), so exiting search slides "down"
    // exactly like clearing the query does; later groups slide down, earlier up.
    const fromIdx = search.mode
      ? -1
      : visibleGroups.findIndex((g) => g.id === selectedGroupId);
    const toIdx = visibleGroups.findIndex((g) => g.id === groupId);
    const dir: "up" | "down" = toIdx < fromIdx ? "up" : "down";
    await search.slideSwap(dir, () => {
      search.mode = false;
      search.query = "";
      selectedGroupId = groupId;
      // Reset while offscreen so the new group starts at the top. Search-exit
      // (the X button) intentionally does NOT reset, returning you where you were.
      if (scroll.scrollEl) scroll.scrollEl.scrollTop = 0;
    });
  }

  // Container width watcher driving horizontal-mode flip.
  $effect(() => layout.observe());

  onMount(async () => {
    // Open on a specific group when an external flow requested one (e.g. the
    // add-core wizard returning to the Cores manager), then clear the request.
    if (viewState.pendingSettingsGroup) {
      selectedGroupId = viewState.pendingSettingsGroup;
      viewState.pendingSettingsGroup = null;
    }
    // Seed collapse state: every labeled section starts expanded except those
    // flagged `defaultCollapsed`.
    expandedSections = defaultExpandedSections();
    void loadPairedCores();
    try {
      const all = await platform().monitors.available();
      const mapped = all.map((mon, i) => ({
        id: mon.id || i.toString(),
        name: mon.name || `Monitor ${i + 1}`,
        isPrimary: mon.isPrimary,
      }));
      mapped.sort((a, b) =>
        a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
      );
      monitors = mapped;
    } catch (e) {
      log.error("Failed to load monitors:", e);
    }
    if (isTauri()) {
      try {
        fonts = await platform().fonts.list();
      } catch (e) {
        log.error("Failed to load fonts:", e);
      }
    }
    form.validateAllFields();
    search.inputEl?.focus();
    scroll.updateFades();
  });

  // Single pending-downloads popup, driven by the core's authoritative
  // `missing` requirements snapshot. Shows whenever something required is
  // missing; "Do It Later" records the current missing-set so it stops
  // nagging, but a settings change that alters the set (e.g. picking a
  // different model) re-shows the popup with the full updated list.
  let dismissedSignature = $state<string | null>(null);
  let shownSignature = $state<string | null>(null);

  // While the core is unreachable, settings can't be read/written: lock the
  // view down (the search box clears, core groups + fields disable via the
  // sidebar / the inert wrapper below) and dismiss the pending-downloads modal
  // since acting on it requires the core.
  $effect(() => {
    if (!connectionState.reconnecting) return;
    if (search.query) search.clear();
    if (confirmState.pending?.title === "Pending Downloads") confirmState.cancel();
  });

  $effect(() => {
    const sig = downloadsState.missingSignature;
    // Don't (re)open the pending popup while disconnected; the close effect
    // above tears down any open one.
    if (connectionState.reconnecting) return;
    // Only auto-popup while there are unapproved missing files. Once the user
    // approves (downloads start), stop re-popping even though the app is still
    // gated and the missing set is shrinking as files land.
    if (!downloadsState.needsApproval) {
      dismissedSignature = null;
      shownSignature = null;
      return;
    }
    // Re-show whenever the missing set changes (e.g. picking a different model
    // preset), even while the popup is open, so it reflects the new set instead
    // of the stale one. `shownSignature` guards against re-issuing for the set
    // already on screen (which would otherwise reopen it right after Download).
    if (sig === dismissedSignature || sig === shownSignature) return;
    shownSignature = sig;
    downloadsState.requestRequiredModal({
      onConfirm: () => (dismissedSignature = null),
      onCancel: () => (dismissedSignature = sig),
    });
  });

  function toggleSection(key: string) {
    const next = new Set(expandedSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedSections = next;
  }

  const withScrollAnchor = (fn: () => void) => scroll.withAnchor(fn);

  // Section keys (`${groupId}-${sectionIndex}`) for a group's labeled (thus
  // collapsible) sections. Unlabeled sections render inline and have no key.
  function groupLabeledSectionKeys(groupId: string): string[] {
    const group = SETTINGS_SCHEMA.find((g) => g.id === groupId);
    if (!group) return [];
    const keys: string[] = [];
    group.sections.forEach((section, si) => {
      if (section.label) keys.push(`${groupId}-${si}`);
    });
    return keys;
  }

  function expandAllInGroup(groupId: string) {
    withScrollAnchor(() => {
      const next = new Set(expandedSections);
      for (const key of groupLabeledSectionKeys(groupId)) next.add(key);
      expandedSections = next;
    });
  }

  function collapseAllInGroup(groupId: string) {
    withScrollAnchor(() => {
      const next = new Set(expandedSections);
      for (const key of groupLabeledSectionKeys(groupId)) next.delete(key);
      expandedSections = next;
    });
  }

  // Restore a group's sections to their schema defaults (expanded unless the
  // section is `defaultCollapsed`). Caller wraps in withScrollAnchor.
  function resetGroupToDefault(groupId: string) {
    const group = SETTINGS_SCHEMA.find((g) => g.id === groupId);
    if (!group) return;
    const next = new Set(expandedSections);
    group.sections.forEach((section, si) => {
      if (!section.label) return;
      const key = `${groupId}-${si}`;
      if (section.defaultCollapsed) next.delete(key);
      else next.add(key);
    });
    expandedSections = next;
  }

  const themeOverride = $derived(
    settingsState.currentSettings["appearance.settingsDefaultColor"] as string,
  );
  const themeOverrideHex = $derived(
    hasAlpha(themeOverride) ? themeOverride : null,
  );
</script>

<div style:display="contents" style:--default-base={themeOverrideHex}>
  <!-- Fixed width (capped to the available space) instead of `w-full`, which
       made the bubble size to its content. Content-fit width fed the
       responsive horizontal-mode flip, a feedback loop that could settle narrow
       when a modal overlaid the panel during its first measurement. A
       deterministic width removes that loop entirely. -->
  <Bubble
    selectedAlignment={settingsState.getAlignment()}
    extraClass="flex flex-col gap-3 overflow-hidden transition-all w-[760px] max-w-[calc(100vw-5rem)] h-80vh relative"
  >
    <!-- Settings Header and Back Button -->
    <div class="flex gap-2 items-center text-2xl relative">
      <SearchInput
        bind:value={search.query}
        bind:el={search.inputEl}
        placeholder={connectionState.reconnecting
          ? "Reconnecting to core..."
          : "Search settings..."}
        ariaLabel="Search settings"
        disabled={connectionState.reconnecting}
        oninput={() => search.onInput()}
        onfocus={() => {
          if (search.query.trim() && !search.mode) {
            void search.setMode(true);
          }
        }}
        onclear={() => search.clear()}
      />
      <IconButton
        icon="i-material-symbols-bolt-rounded"
        title="Quick Settings"
        size="lg"
        variant="subtle"
        surface="circle"
        onclick={() => viewState.navigate("quickSettings")}
      />
      <IconButton
        icon="i-material-symbols-ios-share-rounded"
        title="Import / Export Settings"
        size="lg"
        variant="subtle"
        surface="circle"
        onclick={() => (shareOpen = true)}
      />
      <!-- Hub icon (Core Management) is intentionally hidden for now: the
           spec says "management only done at the start and no option to
           change the core connection" until a dedicated cores UI lands.
           Users can still reach it indirectly: unpairing the active core
           returns the app to the destination chooser. -->
      <IconButton
        icon="i-material-symbols-close-rounded"
        title="Back to Chat"
        size="lg"
        variant="subtle"
        surface="circle"
        onclick={() => viewState.navigate("chat")}
      />
    </div>

    {#if pairedCores.length > 1}
      <!-- Multi-core "editing settings for: <core>" picker. Switches the
           core-side settings store so Settings groups marked destination:"core"
           read/write against the selected core's /api/v1/settings. -->
      <div class="flex items-center gap-2 px-1 py-1 text-sm">
        <span class="text-default-600">Editing settings for:</span>
        <select
          class="bg-surface-inset text-default-800 rounded-medium px-2 py-1 hover:cursor-pointer"
          bind:value={selectedCoreId}
          onchange={() => onSelectedCoreChanged()}
        >
          {#each pairedCores as c (c.id)}
            <option value={c.id}>{c.name}</option>
          {/each}
        </select>
      </div>
    {/if}

    <div class="flex flex-1 overflow-hidden min-h-0 -mr-2 gap-3">
      <!-- Sidebar -->
      <SettingsSidebar
        {selectedGroupId}
        onSelect={selectGroup}
        llmStatus={serversState.serverStatuses.llama}
        sttStatus={serversState.serverStatuses.speech}
        ttsStatus={serversState.serverStatuses.speech}
        {withScrollAnchor}
      />

      <!-- Main Panel -->
      <div class="relative flex-1 min-h-0 min-w-0">
        <div
          class="tomat-scroll overflow-y-auto pr-2 h-full"
          bind:this={scroll.scrollEl}
          bind:clientHeight={viewportHeight}
          onscroll={() => scroll.updateFades()}
        >
          <div bind:this={layout.containerEl} class="relative">
            <div
              bind:this={search.layerEl}
              class:will-change-transform={animationsEnabled}
            >
              {#if search.mode && search.query.trim()}
                <div class="flex flex-col gap-4">
                  {#each searchFields(search.query, settingsState.currentSettings) as group (group.sectionKey)}
                    <div class="flex flex-col gap-2">
                      <div
                        class="text-base text-default-500 font-medium uppercase tracking-wide"
                      >
                        {group.groupName}{group.sectionLabel
                          ? ` › ${group.sectionLabel}`
                          : ""}
                      </div>
                      {#each group.fields as field (field.id)}
                        <SettingsField
                          {field}
                          {monitors}
                          {fonts}
                          error={form.validationErrors[field.id] ?? null}
                          horizontal={layout.horizontal}
                          onChange={form.handleChange}
                          onReset={form.resetToDefault}
                          onPresetSelect={form.handlePresetSelect}
                        />
                      {/each}
                    </div>
                  {:else}
                    <div
                      class="bg-surface-inset rounded-large px-4 py-2 text-default-600 text-base"
                    >
                      No matching settings found.
                    </div>
                  {/each}
                </div>
              {:else if selectedGroup}
                {@const omField = objectManagementFieldOf(activeSections)}
                {@const hasCollapsibleSections = activeSections.some(
                  (s) =>
                    !!s.label &&
                    isSectionVisible(s) &&
                    evalCondition(s.visibleWhen, settingsState.currentSettings),
                )}
                {@const descTier = selectedGroup.description
                  ? (selectedGroup.descriptionTier ?? "ondemand")
                  : "none"}
                <section
                  data-group-id={selectedGroup.id}
                  class="flex flex-col"
                  style:height={omField && viewportHeight
                    ? `${viewportHeight}px`
                    : undefined}
                  style:min-height={!omField && viewportHeight
                    ? `${viewportHeight}px`
                    : undefined}
                >
                  <div class="sticky top-0 z-20">
                    <SectionHeader label={selectedGroup.name} level="group">
                      {#snippet badge()}
                        <!-- Destination chip(s): whether a setting lives on the
                             paired core, the local client, or (for hybrid
                             groups) both. One chip per destination. -->
                        <span class="inline-flex items-center gap-1">
                          {#each groupDestinations(selectedGroup) as dest (dest)}
                            <DestinationChip {dest} />
                          {/each}
                        </span>
                      {/snippet}
                      {#snippet actions()}
                        {#if descTier !== "none"}
                          <!-- Leftmost; same subtle color as expand/collapse.
                               Shown for any group with a description (the toggle
                               works for both the always and ondemand tiers). -->
                          <IconButton
                            icon="i-material-symbols-info-outline-rounded"
                            title="Toggle description"
                            size="sm"
                            variant="subtle"
                            aria-pressed={groupDescOpen}
                            onclick={() => (groupDescOpen = !groupDescOpen)}
                          />
                        {/if}
                        {#if hasCollapsibleSections}
                          <IconButton
                            icon="i-material-symbols-unfold-more-rounded"
                            title="Expand all sections"
                            size="sm"
                            variant="subtle"
                            onclick={() => expandAllInGroup(selectedGroup.id)}
                          />
                          <IconButton
                            icon="i-material-symbols-unfold-less-rounded"
                            title="Collapse all sections"
                            size="sm"
                            variant="subtle"
                            onclick={() => collapseAllInGroup(selectedGroup.id)}
                          />
                        {/if}
                      {/snippet}
                    </SectionHeader>
                  </div>
                  {#if selectedGroup.description && groupDescOpen}
                    <!-- Group-level description, toggled by the header info
                         button. shrink-0 so it sits above the (scrolling) group
                         body in both the object-management and sectioned views. -->
                    <div class="shrink-0 pt-1">
                      <HelpText text={selectedGroup.description} />
                    </div>
                  {/if}
                  {#snippet tabBody()}
                    {#if omField}
                      <!-- Object-management groups own the full panel height and
                           scroll internally, so the field renders in a definite-
                           height flex child rather than the min-height section
                           flow. -->
                      <div
                        class="flex-1 min-h-0 pt-1 transition-opacity"
                        class:opacity-50={coreGroupLocked}
                        inert={coreGroupLocked}
                      >
                        <SettingsField
                          field={omField}
                          {monitors}
                          {fonts}
                          error={form.validationErrors[omField.id] ?? null}
                          horizontal={layout.horizontal}
                          onChange={form.handleChange}
                          onReset={form.resetToDefault}
                          onPresetSelect={form.handlePresetSelect}
                        />
                      </div>
                    {:else}
                      <!-- gap-3 separates sections so each (tight) section reads
                           as a unit with clear space before the next one. -->
                      <div
                        class="flex flex-col gap-3 transition-opacity"
                        class:opacity-50={coreGroupLocked}
                        inert={coreGroupLocked}
                      >
                        {#each selectedGroup.sections as section, si}
                          {#if isSectionVisible(section) && (!selectedGroup.tabs || section.tab === contentTabId)}
                            <SettingsSection
                              {section}
                              sectionKey={`${selectedGroup.id}-${si}`}
                              isExpanded={expandedSections.has(
                                `${selectedGroup.id}-${si}`,
                              )}
                              {monitors}
                              {fonts}
                              validationErrors={form.validationErrors}
                              horizontal={layout.horizontal}
                              onToggle={toggleSection}
                              onChange={form.handleChange}
                              onReset={form.resetToDefault}
                              onPresetSelect={form.handlePresetSelect}
                            />
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  {/snippet}
                  {#if selectedGroup.tabs}
                    <!-- Tab selector, below the group description. shrink-0 so it
                         stays put above the (scrolling or full-height) tab body. -->
                    <div class="shrink-0 pt-2 pb-3">
                      <SettingsTabs
                        tabs={selectedGroup.tabs}
                        active={activeTabId}
                        onSelect={selectTab}
                        slideMs={tabSlideMs}
                      />
                    </div>
                    <!-- The tab body slides horizontally on tab change (selectTab).
                         overflow-x clip contains the offscreen layer so the panel
                         never grows a horizontal scrollbar mid-slide; the y axis
                         stays visible so the manager / sections keep their normal
                         vertical scroll. -->
                    <div class="relative flex-1 min-h-0 flex flex-col" style:overflow-x="clip">
                      <div
                        bind:this={tabLayerEl}
                        class="flex-1 min-h-0 flex flex-col"
                        class:will-change-transform={animationsEnabled}
                      >
                        {@render tabBody()}
                      </div>
                    </div>
                  {:else}
                    {@render tabBody()}
                  {/if}
                </section>
              {/if}
            </div>
          </div>
        </div>
        <!-- Top fade is search-only: the normal group view has a sticky section
             header at the top, so a fade there would just wash it out. -->
        <div
          class="absolute left-0 right-0 top-0 h-6 pointer-events-none z-1 bg-gradient-to-b from-default-50 to-transparent transition-opacity duration-100 {scroll.showTopFade &&
          search.mode &&
          search.query.trim()
            ? 'opacity-100'
            : 'opacity-0'}"
        ></div>
        <div
          class="absolute left-0 right-0 bottom-0 h-6 pointer-events-none z-1 bg-gradient-to-t from-default-50 to-transparent transition-opacity duration-100 {scroll.showBottomFade
            ? 'opacity-100'
            : 'opacity-0'}"
        ></div>
      </div>
    </div>

    <ConfirmModal />
    <DownloadsModal />
    <DeletionsModal />
    <ShareModal open={shareOpen} onClose={() => (shareOpen = false)} />
    <ColorPickerModal />
  </Bubble>
</div>
