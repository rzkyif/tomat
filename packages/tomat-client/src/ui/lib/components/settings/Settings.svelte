<script lang="ts">
  import { onMount } from "svelte";
  import { platform } from "$lib/platform";
  import { isTauri } from "$lib/shared/env";
  import { errMessage, SETTINGS_SCHEMA } from "@tomat/shared";
  import type { PresetOption } from "@tomat/shared";
  import type { Monitor } from "$lib/shared/types";
  import { hasAlpha } from "$lib/shared/color";
  import { getLogger } from "$lib/shared/log";

  const log = getLogger("settings");

  // Sidecar (re)starts are server-side now: PATCH /api/v1/settings triggers
  // core to spawn / restart its sidecars based on the new config. The UI
  // doesn't need to call anything explicit anymore.
  async function startConfiguredServices(): Promise<void> {
    /* no-op: handled server-side */
  }
  import Bubble from "../ui/Bubble.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import SearchInput from "../ui/SearchInput.svelte";
  import SectionHeader from "../ui/SectionHeader.svelte";
  import { settingsState, serversState, downloadsState, viewState } from "../../state";
  import { confirmState } from "$lib/state/confirm.svelte";
  import { connectionState } from "$lib/state/connection.svelte";
  import {
    evalCondition,
    findField,
    getValidationError,
    getPresetFieldIds,
    getConditionDeps,
    isGroupVisible,
    isSectionVisible,
    defaultExpandedSections,
    searchFields,
  } from "@tomat/shared";
  import { useSettingsSearch } from "$lib/composables/use-settings-search.svelte";
  import { useSettingsScroll } from "$lib/composables/use-settings-scroll.svelte";
  import { useResponsiveLayout } from "$lib/composables/use-responsive-layout.svelte";

  // Sub-components
  import SettingsSidebar from "./SettingsSidebar.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsField from "./SettingsField.svelte";
  import ColorPickerModal from "./ColorPickerModal.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import DownloadsModal from "./DownloadsModal.svelte";

  let monitors: Monitor[] = $state([]);
  let fonts: string[] = $state([]);
  let expandedSections = $state<Set<string>>(new Set());

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
  let validationErrors = $state<Record<string, string>>({});

  const search = useSettingsSearch();
  const scroll = useSettingsScroll();
  const layout = useResponsiveLayout();

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

  // When reconnecting, a core-destination group's fields can't be edited (the
  // writes would fail). `inert` blocks all pointer/focus interaction for every
  // nested field at once; pair with dimming for the visual cue.
  const coreGroupLocked = $derived(
    connectionState.reconnecting && selectedGroup?.destination === "core",
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
    validateAllFields();
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
    if (!downloadsState.hasPending) {
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

  function validateAllFields() {
    for (const group of SETTINGS_SCHEMA) {
      for (const section of group.sections) {
        for (const field of section.fields) {
          if (
            field.type === "command_preview" ||
            field.type === "services" ||
            field.type === "storage" ||
            field.type === "snippets" ||
            field.type === "cores"
          )
            continue;
          const value = settingsState.currentSettings[field.id];
          validateField(field.id, value);
        }
      }
    }
  }

  // Apply optimistically. The core recomputes the required-files snapshot and
  // re-broadcasts it; the pending-downloads popup ($effect above) reacts with
  // the full updated list. No pre-download probe / revert here.
  async function handleChange(key: string, value: any) {
    validateField(key, value);
    if (validationErrors[key]) return;
    await tryApply(key, value);
  }

  async function tryApply(key: string, value: any) {
    try {
      await applyFieldChange(key, value);
    } catch (e) {
      validationErrors = {
        ...validationErrors,
        [key]: errMessage(e),
      };
    }
  }

  async function applyFieldChange(key: string, value: any) {
    if (
      key.startsWith("llm.") &&
      key !== "llm.preset" &&
      !key.startsWith("llm.external.") &&
      getPresetFieldIds("llm").has(key)
    ) {
      if (settingsState.currentSettings["llm.preset"] !== "custom") {
        await settingsState.updateSetting("llm.preset", "custom");
      }
    }
    if (
      key.startsWith("stt.") &&
      key !== "stt.preset" &&
      !key.startsWith("stt.external.") &&
      getPresetFieldIds("stt").has(key)
    ) {
      if (settingsState.currentSettings["stt.preset"] !== "custom") {
        await settingsState.updateSetting("stt.preset", "custom");
      }
    }
    if (
      key.startsWith("prompts.") &&
      key !== "prompts.defaultSystemPrompt.preset" &&
      getPresetFieldIds("prompts").has(key)
    ) {
      if (
        settingsState.currentSettings["prompts.defaultSystemPrompt.preset"] !==
        "custom"
      ) {
        await settingsState.updateSetting(
          "prompts.defaultSystemPrompt.preset",
          "custom",
        );
      }
    }
    await settingsState.updateSetting(key, value);
    reEvaluateDeps(key);
  }

  function validateField(fieldId: string, value: any) {
    const field = findField(fieldId);
    if (!field) return;

    const isOptional = field.optionalWhen
      ? evalCondition(field.optionalWhen, settingsState.currentSettings)
      : !!field.optional;

    if (
      !isOptional &&
      (value === undefined || value === null || value === "")
    ) {
      validationErrors = {
        ...validationErrors,
        [fieldId]: "This field is required",
      };
      return;
    }

    if (
      validationErrors[field.id] === "This field is required" &&
      (isOptional || (value !== "" && value !== undefined && value !== null))
    ) {
      const { [fieldId]: _, ...rest } = validationErrors;
      validationErrors = rest;
    }

    const regex = "regex" in field ? field.regex : undefined;
    if (!regex) return;

    const error = getValidationError(regex, value);
    if (error) {
      validationErrors = { ...validationErrors, [fieldId]: error };
    } else {
      const { [fieldId]: _, ...rest } = validationErrors;
      validationErrors = rest;
    }
  }

  function resetToDefault(fieldId: string) {
    const field = findField(fieldId);
    if (field) {
      handleChange(fieldId, field.defaultValue);
    }
  }

  // Apply optimistically (like handleChange); the requirements popup reacts to
  // whatever the core then reports as missing.
  async function handlePresetSelect(fieldId: string, option: PresetOption) {
    const updates: Record<string, any> = { [fieldId]: option.id };
    if (option.defaults) Object.assign(updates, option.defaults);
    await applyPresetUpdates(updates);
  }

  async function applyPresetUpdates(updates: Record<string, any>) {
    await settingsState.updateSettings(updates);
    validateAllFields();
    reEvaluateDeps(...Object.keys(updates));
  }

  function reEvaluateDeps(...keys: string[]) {
    const deps = getConditionDeps();
    const next = new Set(expandedSections);
    let expandChanged = false;

    for (const key of keys) {
      const entries = deps.get(key);
      if (!entries) continue;

      for (const dep of entries) {
        if (dep.kind === "field" && dep.condition === "optionalWhen") {
          validateField(
            dep.fieldId,
            settingsState.currentSettings[dep.fieldId],
          );
        } else if (dep.kind === "section" && dep.condition === "expandWhen") {
          const sectionKey = `${dep.groupId}-${dep.sectionIndex}`;
          const group = SETTINGS_SCHEMA.find((g) => g.id === dep.groupId);
          const section = group?.sections[dep.sectionIndex];
          if (
            section &&
            evalCondition(section.expandWhen, settingsState.currentSettings)
          ) {
            next.add(sectionKey);
          } else {
            next.delete(sectionKey);
          }
          expandChanged = true;
        }
      }
    }

    if (expandChanged) {
      expandedSections = next;
    }
  }

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
        title="Quick Setup"
        size="lg"
        variant="subtle"
        surface="circle"
        onclick={() => viewState.navigate("quickSetup")}
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
        sttStatus={serversState.serverStatuses.whisper}
        ttsStatus={serversState.serverStatuses.tts}
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
                          error={validationErrors[field.id] ?? null}
                          horizontal={layout.horizontal}
                          onChange={handleChange}
                          onReset={resetToDefault}
                          onPresetSelect={handlePresetSelect}
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
                <section
                  data-group-id={selectedGroup.id}
                  class="flex flex-col"
                  style:min-height={viewportHeight
                    ? `${viewportHeight}px`
                    : undefined}
                >
                  <div class="sticky top-0 z-20">
                    <SectionHeader label={selectedGroup.name} level="group">
                      {#snippet badge()}
                        <!-- Destination chip clarifies whether a setting
                             lives on the paired core or on the local
                             client. Shown unconditionally so single-core
                             users still see the distinction.
                             Custom inline badge sized to the header text
                             height and painted with the input-field
                             surface (bg-surface-inset). -->
                        <span
                          class="text-[10px] font-medium uppercase tracking-wider px-1.5 inline-flex items-center h-4 leading-none rounded-medium bg-surface-inset text-default-700"
                          title={selectedGroup.destination === "core"
                            ? "Stored on the paired core (~/.tomat/core/settings.json)"
                            : "Stored on this device (~/.tomat/client/settings.json)"}
                        >
                          {selectedGroup.destination === "core"
                            ? "Core"
                            : "Client"}
                        </span>
                      {/snippet}
                      {#snippet actions()}
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
                      {/snippet}
                    </SectionHeader>
                  </div>
                  <!-- gap-3 separates sections so each (tight) section reads
                       as a unit with clear space before the next one. -->
                  <div
                    class="flex flex-col gap-3 transition-opacity"
                    class:opacity-50={coreGroupLocked}
                    inert={coreGroupLocked}
                  >
                    {#each selectedGroup.sections as section, si}
                      {#if isSectionVisible(section)}
                        <SettingsSection
                          {section}
                          sectionKey={`${selectedGroup.id}-${si}`}
                          isExpanded={expandedSections.has(
                            `${selectedGroup.id}-${si}`,
                          )}
                          {monitors}
                          {fonts}
                          {validationErrors}
                          horizontal={layout.horizontal}
                          onToggle={toggleSection}
                          onChange={handleChange}
                          onReset={resetToDefault}
                          onPresetSelect={handlePresetSelect}
                        />
                      {/if}
                    {/each}
                  </div>
                </section>
              {/if}
            </div>
          </div>
        </div>
        <div
          class="absolute left-0 right-0 bottom-0 h-6 pointer-events-none z-1 bg-gradient-to-t from-default-50 to-transparent transition-opacity duration-100 {scroll.showBottomFade
            ? 'opacity-100'
            : 'opacity-0'}"
        ></div>
      </div>
    </div>

    <ConfirmModal />
    <DownloadsModal />
    <ColorPickerModal />
  </Bubble>
</div>
