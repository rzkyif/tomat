<script lang="ts">
  import { onMount } from "svelte";
  import { primaryMonitor, availableMonitors } from "@tauri-apps/api/window";
  import { SETTINGS_SCHEMA } from "$lib/shared/settings";
  import type { PresetOption } from "$lib/shared/settings";
  import type { Monitor } from "$lib/shared/types";
  import { startConfiguredServices } from "$lib/sidecar/manager";
  import { hasAlpha } from "$lib/shared/color";
  import Bubble from "../Bubble.svelte";
  import {
    settingsState,
    serversState,
    confirmState,
    downloadsState,
  } from "../../state";
  import {
    evalCondition,
    findField,
    getValidationError,
    getPresetFieldIds,
    getConditionDeps,
    isGroupVisible,
    isSectionVisible,
    searchFields,
  } from "$lib/shared/settings";
  import { useSettingsSearch } from "$lib/composables/useSettingsSearch.svelte";
  import { useScrollSpy } from "$lib/composables/useScrollSpy.svelte";
  import { useResponsiveLayout } from "$lib/composables/useResponsiveLayout.svelte";

  // Sub-components
  import SettingsSidebar from "./SettingsSidebar.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsField from "./SettingsField.svelte";
  import ColorPickerModal from "./ColorPickerModal.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import DownloadsModal from "./DownloadsModal.svelte";
  import {
    collectDownloadCandidates,
    enqueueDownloads,
    inferGroupIdFromKey,
    planDownloads,
    planToEnqueueSpec,
    type DownloadPlan,
  } from "$lib/shared/download";

  let { toggleSettings } = $props<{
    toggleSettings: () => void;
  }>();

  let monitors: Monitor[] = $state([]);
  let expandedSections = $state<Set<string>>(new Set());
  let validationErrors = $state<Record<string, string>>({});

  const search = useSettingsSearch();
  const scroll = useScrollSpy(SETTINGS_SCHEMA[0].id);
  const layout = useResponsiveLayout();

  const showAdvanced = $derived(
    !!settingsState.currentSettings["appearance.settings.showAdvanced"],
  );
  const visibleGroups = $derived(
    SETTINGS_SCHEMA.filter((g) => isGroupVisible(g, showAdvanced)),
  );
  scroll.setVisibleGroups(() => visibleGroups);

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

  async function handleSidebarSelect(groupId: string) {
    if (search.mode) {
      search.query = "";
      // Await so groupRefs are populated by the time we scroll.
      await search.setMode(false);
    }
    scroll.scrollTo(groupId, animationsEnabled);
  }

  // Container width watcher driving horizontal-mode flip.
  $effect(() => layout.observe());

  onMount(async () => {
    try {
      const [pm, all] = await Promise.all([
        primaryMonitor(),
        availableMonitors(),
      ]);

      const mapped = all.map((mon, i) => ({
        id: mon.name || i.toString(),
        name: mon.name || `Monitor ${i + 1}`,
        isPrimary: pm ? mon.name === pm.name : false,
      }));

      mapped.sort((a, b) =>
        a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
      );
      monitors = mapped;
    } catch (e) {
      console.error("Failed to load monitors:", e);
    }
    validateAllFields();
    search.inputEl?.focus();
    scroll.updateFades();
  });

  // If any required HF files were missing at app startup, prompt the user
  // with a ConfirmModal listing all of them. Wrapped in $effect so it
  // also fires when the probe finishes after Settings has mounted. The
  // modal mirrors the setting-change download prompt (same title /
  // message / Download + Cancel buttons) for visual consistency.
  //
  // Confirm enqueues every missing file AND brings up sidecars / TTS
  // (gated until now because no auto-downloads run at startup). Cancel
  // closes the modal without changing anything; the cue stays so the
  // next time the user opens Settings the prompt re-appears via the
  // per-mount `askedThisMount` guard.
  let askedThisMount = false;
  $effect(() => {
    if (askedThisMount) return;
    if (downloadsState.startupModalShown) return;
    if (!downloadsState.hasPendingStartup) return;
    askedThisMount = true;
    const plans = downloadsState.pendingStartupRemaining;
    const groups = downloadsState.pendingStartupGroupBySource;
    confirmState.request({
      title: "Download required",
      message: `The following file${plans.length === 1 ? "" : "s"} will be downloaded to ~/.tomat/models/:`,
      confirmLabel: "Download",
      downloads: plans,
      onConfirm: async () => {
        downloadsState.startupModalShown = true;
        const items = plans.map((p) =>
          planToEnqueueSpec(p, groups[p.path] ?? "general"),
        );
        await enqueueDownloads(items);
        // Bring up every locally-managed service. Sidecar `ensure()`
        // calls join the in-flight downloads we just enqueued via the
        // manager's id-based dedupe and resolve once each file lands.
        void startConfiguredServices();
      },
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
            field.type === "snippets"
          )
            continue;
          const value = settingsState.currentSettings[field.id];
          validateField(field.id, value);
        }
      }
    }
  }

  async function handleChange(key: string, value: any) {
    validateField(key, value);
    if (validationErrors[key]) return;

    const prev = { ...$state.snapshot(settingsState.currentSettings) };
    const next = { ...prev, [key]: value };
    const candidates = collectDownloadCandidates(prev, next);
    if (candidates.length > 0) {
      const plans = await planDownloads(candidates);
      if (plans.length > 0) {
        requestDownloadConfirm(plans, inferGroupIdFromKey(key), () =>
          tryApply(key, value),
        );
        return;
      }
    }
    await tryApply(key, value);
  }

  async function tryApply(key: string, value: any) {
    try {
      await applyFieldChange(key, value);
    } catch (e) {
      validationErrors = {
        ...validationErrors,
        [key]: e instanceof Error ? e.message : String(e),
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

    if (!field.regex) return;

    const error = getValidationError(field.regex, value);
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

  async function handlePresetSelect(fieldId: string, option: PresetOption) {
    const updates: Record<string, any> = { [fieldId]: option.id };
    if (option.defaults) Object.assign(updates, option.defaults);

    const prev = { ...$state.snapshot(settingsState.currentSettings) };
    const next = { ...prev, ...updates };
    const candidates = collectDownloadCandidates(prev, next);
    if (candidates.length > 0) {
      const plans = await planDownloads(candidates);
      if (plans.length > 0) {
        requestDownloadConfirm(plans, inferGroupIdFromKey(fieldId), () =>
          applyPresetUpdates(updates),
        );
        return;
      }
    }
    await applyPresetUpdates(updates);
  }

  async function applyPresetUpdates(updates: Record<string, any>) {
    await settingsState.updateSettings(updates);
    validateAllFields();
    reEvaluateDeps(...Object.keys(updates));
  }

  function requestDownloadConfirm(
    plans: DownloadPlan[],
    groupId: string,
    apply: () => Promise<void>,
  ) {
    confirmState.request({
      title: "Download required",
      message: `The following file${plans.length === 1 ? "" : "s"} will be downloaded to ~/.tomat/models/:`,
      confirmLabel: "Download",
      downloads: plans,
      onConfirm: async () => {
        // Enqueue the downloads through the central manager BEFORE applying
        // the setting. The sidecar restart triggered by the apply call will
        // then await the same files via the manager's in-flight dedupe.
        await enqueueDownloads(plans.map((p) => planToEnqueueSpec(p, groupId)));
        await apply();
      },
      onCancel: () => {
        settingsState.currentSettings = { ...settingsState.currentSettings };
      },
    });
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

  const themeOverride = $derived(
    settingsState.currentSettings["appearance.settingsDefaultColor"] as string,
  );
  const themeOverrideHex = $derived(
    hasAlpha(themeOverride) ? themeOverride : null,
  );
</script>

<div style:display="contents" style:--default-base={themeOverrideHex}>
  <Bubble
    selectedAlignment={settingsState.getAlignment()}
    extraClass="flex flex-col gap-3 overflow-hidden transition-all w-full h-80vh relative"
  >
    <!-- Settings Header and Back Button -->
    <div class="flex gap-2 items-center text-2xl relative">
      <div
        class="relative h-10 bg-default-200 rounded-large overflow-hidden w-full flex items-center px-4 pr-8"
      >
        <input
          type="text"
          placeholder="Search settings..."
          class="bg-transparent outline-none text-base text-default-600 w-full"
          bind:this={search.inputEl}
          bind:value={search.query}
          oninput={() => search.onInput()}
          onfocus={() => {
            if (search.query.trim() && !search.mode) {
              void search.setMode(true);
            }
          }}
        />
        {#if search.query}
          <button
            class="flex absolute right-3 top-1/2 -translate-y-1/2 text-default-400 hover:text-default-600 text-lg cursor-pointer transition-colors"
            onclick={() => search.clear()}
            title="Clear search"
          >
            <i class="flex i-material-symbols-close-rounded"></i>
          </button>
        {:else}
          <i
            class="flex i-material-symbols-search-rounded absolute right-3 top-1/2 -translate-y-1/2 text-default-400 text-lg pointer-events-none"
          ></i>
        {/if}
      </div>
      <button
        class="hover:text-default-700 text-default-400 transition-colors p-2 rounded-full bg-default-200 hover:cursor-pointer"
        onclick={toggleSettings}
        title="Back to Chat"
      >
        <i class="flex i-material-symbols-close-rounded"></i>
      </button>
    </div>

    <div class="flex flex-1 overflow-hidden min-h-0 -mr-2 gap-3">
      <!-- Sidebar -->
      <SettingsSidebar
        selectedGroupId={scroll.selectedGroupId}
        onSelect={handleSidebarSelect}
        llmStatus={serversState.serverStatuses.llm}
        sttStatus={serversState.serverStatuses.stt}
        bunStatus={serversState.serverStatuses.bun}
        {withScrollAnchor}
      />

      <!-- Main Panel -->
      <div class="relative flex-1 min-h-0 min-w-0">
        <div
          class="settings-scroll overflow-y-auto pr-2 h-full"
          bind:this={scroll.scrollEl}
          bind:clientHeight={scroll.viewportHeight}
          onscroll={() => scroll.onScroll(search.mode)}
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
                        class="text-sm text-default-500 font-medium uppercase tracking-wide"
                      >
                        {group.groupName}{group.sectionLabel
                          ? ` › ${group.sectionLabel}`
                          : ""}
                      </div>
                      {#each group.fields as field (field.id)}
                        <SettingsField
                          {field}
                          {monitors}
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
                      class="bg-default-200 rounded-large px-4 py-2 text-default-600 text-base"
                    >
                      No matching settings found.
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="flex flex-col gap-4">
                  {#each visibleGroups as group, gi (group.id)}
                    {@const isLast = gi === visibleGroups.length - 1}
                    {#if gi > 0}
                      <div
                        class="h-0.5 mt-2 bg-default-400"
                        aria-hidden="true"
                      ></div>
                    {/if}
                    {@const firstRenderedSection = group.sections.find(
                      (s) =>
                        isSectionVisible(s, showAdvanced) &&
                        evalCondition(
                          s.visibleWhen,
                          settingsState.currentSettings,
                        ),
                    )}
                    {@const needsTopGap =
                      firstRenderedSection && !firstRenderedSection.label}
                    <section
                      data-group-id={group.id}
                      bind:this={scroll.groupRefs[group.id]}
                      class="flex flex-col"
                      style={isLast && scroll.viewportHeight
                        ? `min-height: ${scroll.viewportHeight}px`
                        : undefined}
                    >
                      <div class="sticky top-0 z-20">
                        <h2
                          class="flex items-center h-7 bg-default-300 text-sm text-default-800 font-medium uppercase tracking-wide"
                        >
                          {group.name}
                        </h2>
                        <div
                          class="absolute left-0 right-0 top-full h-3 bg-gradient-to-b from-default-300 to-transparent pointer-events-none"
                        ></div>
                      </div>
                      <div
                        class="flex flex-col gap-2 {needsTopGap ? 'pt-2' : ''}"
                      >
                        {#each group.sections as section, si}
                          {#if isSectionVisible(section, showAdvanced)}
                            <SettingsSection
                              {section}
                              sectionKey={`${group.id}-${si}`}
                              isExpanded={expandedSections.has(
                                `${group.id}-${si}`,
                              )}
                              {monitors}
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
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
        <div
          class="absolute left-0 right-0 bottom-0 h-6 pointer-events-none z-1 bg-gradient-to-t from-default-300 to-transparent transition-opacity duration-100 {scroll.showBottomFade
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

<style>
  /* Scrollbar colors track the themable default scale so a tinted Default
     Color flows through. Light and dark variants pull from `--default-200`
     and `--default-d-200`; hover steps to `--default-400` / `--default-d-400`
     for a consistent darkening (and lightening in dark mode). */
  .settings-scroll::-webkit-scrollbar {
    width: 8px;
  }
  .settings-scroll::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }
  .settings-scroll::-webkit-scrollbar-thumb {
    background: var(--default-200);
    border-radius: 4px;
  }
  .settings-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-400);
  }
  :global(html.dark) .settings-scroll::-webkit-scrollbar-thumb {
    background: var(--default-d-200);
  }
  :global(html.dark) .settings-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--default-d-400);
  }
</style>
