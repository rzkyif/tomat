<script lang="ts">
  import { onMount } from "svelte";
  import { SETTINGS_SCHEMA } from "$lib/shared/settings";
  import type { PresetOption } from "$lib/shared/settings";
  import type { Monitor } from "$lib/shared/types";
  import Bubble from "./Bubble.svelte";
  import { settingsState, serversState } from "../state";
  import {
    evalCondition,
    findField,
    getValidationError,
    getPresetFieldIds,
    getConditionDeps,
    searchFields,
  } from "$lib/shared/settings";

  // Sub-components
  import SettingsSidebar from "./settings/SettingsSidebar.svelte";
  import SettingsSection from "./settings/SettingsSection.svelte";
  import SettingsField from "./settings/SettingsField.svelte";
  import DownloadConfirmationModal from "./DownloadConfirmationModal.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import {
    collectDownloadCandidates,
    planDownloads,
    type DownloadPlan,
  } from "$lib/shared/download";

  let { toggleSettings } = $props<{
    toggleSettings: () => void;
  }>();

  let selectedSettingGroupId = $state<string>(SETTINGS_SCHEMA[0].id);
  let monitors: Monitor[] = $state([]);
  let expandedSections = $state<Set<string>>(new Set());
  let validationErrors = $state<Record<string, string>>({});
  let searchQuery = $state("");
  let searchMode = $state(false);
  let searchInput: HTMLInputElement | undefined = $state();
  let scrollEl: HTMLDivElement | undefined = $state();
  let showTopFade = $state(false);
  let showBottomFade = $state(true);
  let pendingDownload = $state<null | {
    plans: DownloadPlan[];
    apply: () => Promise<void>;
  }>(null);

  function updateScrollFades() {
    if (!scrollEl) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    showTopFade = scrollTop > 0;
    showBottomFade = scrollTop + clientHeight < scrollHeight - 1;
  }

  $effect(() => {
    // Re-check fades when group/search changes reset scroll content
    void [selectedSettingGroupId, searchMode];
    // Wait a tick for DOM to update
    requestAnimationFrame(updateScrollFades);
  });

  onMount(async () => {
    try {
      const { primaryMonitor, availableMonitors } = await import(
        "@tauri-apps/api/window"
      );
      const [pm, all] = await Promise.all([
        primaryMonitor(),
        availableMonitors(),
      ]);

      const mapped = all.map((mon, i) => ({
        id: mon.name || i.toString(),
        name: mon.name || `Monitor ${i + 1}`,
        isPrimary: pm ? mon.name === pm.name : false,
      }));

      // Sort: primary first
      mapped.sort((a, b) =>
        a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
      );
      monitors = mapped;
    } catch (e) {
      console.error("Failed to load monitors:", e);
    }
    // Validate all fields on mount
    validateAllFields();
    searchInput?.focus();
    updateScrollFades();
  });

  function validateAllFields() {
    for (const group of SETTINGS_SCHEMA) {
      for (const section of group.sections) {
        for (const field of section.fields) {
          if (
            field.type === "command_preview" ||
            field.type === "services" ||
            field.type === "storage"
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
        const apply = async () => {
          await applyFieldChange(key, value);
        };
        pendingDownload = { plans, apply };
        return;
      }
    }
    await applyFieldChange(key, value);
  }

  async function applyFieldChange(key: string, value: any) {
    if (
      key.startsWith("llm.") &&
      key !== "llm.preset" &&
      !key.startsWith("llm.external.") &&
      getPresetFieldIds("llm").has(key)
    ) {
      if (
        settingsState.currentSettings["llm.preset"] !== "external" &&
        settingsState.currentSettings["llm.preset"] !== "custom"
      ) {
        await settingsState.updateSetting("llm.preset", "custom");
      }
    }
    if (
      key.startsWith("stt.") &&
      key !== "stt.preset" &&
      !key.startsWith("stt.external.") &&
      getPresetFieldIds("stt").has(key)
    ) {
      if (
        settingsState.currentSettings["stt.preset"] !== "external" &&
        settingsState.currentSettings["stt.preset"] !== "custom"
      ) {
        await settingsState.updateSetting("stt.preset", "custom");
      }
    }
    if (
      key.startsWith("general.") &&
      key !== "general.systemPrompt.preset" &&
      getPresetFieldIds("general").has(key)
    ) {
      if (settingsState.currentSettings["general.systemPrompt.preset"] !== "custom") {
        await settingsState.updateSetting("general.systemPrompt.preset", "custom");
      }
    }
    await settingsState.updateSetting(key, value);
    reEvaluateDeps(key);
  }

  function validateField(fieldId: string, value: any) {
    const field = findField(fieldId);
    if (!field) return;

    // Determine if this field is currently required
    const isOptional = field.optionalWhen
      ? evalCondition(field.optionalWhen, settingsState.currentSettings)
      : !!field.optional;

    // Check required field validation (empty value when not optional)
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

    // Clear required error if value is present or field became optional
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
        const apply = async () => {
          await applyPresetUpdates(updates);
        };
        pendingDownload = { plans, apply };
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

  async function confirmPendingDownload() {
    if (!pendingDownload) return;
    const { apply } = pendingDownload;
    pendingDownload = null;
    await apply();
  }

  function cancelPendingDownload() {
    pendingDownload = null;
    // Force reactive re-read so any DOM inputs reflecting rejected values snap back
    settingsState.currentSettings = { ...settingsState.currentSettings };
  }

  /** Re-evaluate all conditions that depend on the given setting keys. */
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
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  extraClass="flex flex-col gap-3 min-w-0 overflow-hidden transition-all w-full h-150 relative"
>
  <!-- Settings Header and Back Button -->
  <div class="flex gap-2 items-center text-2xl relative">
    <div
      class="relative h-10 bg-default-100 rounded-2xl overflow-hidden w-full flex items-center px-4 pr-8"
    >
      <input
        type="text"
        placeholder="Search settings..."
        class="bg-transparent outline-none text-base text-default-600 w-full"
        bind:this={searchInput}
        bind:value={searchQuery}
        oninput={() => {
          if (searchQuery.trim()) {
            searchMode = true;
            selectedSettingGroupId = "";
          } else {
            searchMode = false;
            selectedSettingGroupId = SETTINGS_SCHEMA[0].id;
          }
        }}
        onfocus={() => {
          if (searchQuery.trim()) {
            searchMode = true;
            selectedSettingGroupId = "";
          }
        }}
      />
      {#if searchQuery}
        <button
          class="flex absolute right-3 top-1/2 -translate-y-1/2 text-default-400 hover:text-default-600 text-lg cursor-pointer transition-colors"
          onclick={() => {
            searchQuery = "";
            searchMode = false;
            selectedSettingGroupId = SETTINGS_SCHEMA[0].id;
            searchInput?.focus();
          }}
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
      class="hover:text-default-700 text-default-400 transition-colors p-2 rounded-full bg-default-100 hover:cursor-pointer"
      onclick={toggleSettings}
      title="Back to Chat"
    >
      <i class="flex i-material-symbols-close-rounded"></i>
    </button>
  </div>

  <div class="flex flex-1 gap-8 overflow-hidden min-h-0 -mr-2">
    <!-- Sidebar -->
    <SettingsSidebar
      bind:selectedGroupId={selectedSettingGroupId}
      onSelect={() => {
        searchMode = false;
      }}
      llmStatus={serversState.serverStatuses.llm}
      sttStatus={serversState.serverStatuses.stt}
    />

    <!-- Main Panel -->
    <div class="relative flex-1 min-h-0 min-w-0">
      <div
        class="absolute left-0 right-0 top-0 h-6 pointer-events-none z-1 bg-gradient-to-b from-neutral-300 dark:from-neutral-600 to-transparent transition-opacity duration-100 {showTopFade
          ? 'opacity-100'
          : 'opacity-0'}"
      ></div>
      <div
        class="settings-scroll flex flex-col gap-2 overflow-y-auto pr-2 h-full"
        bind:this={scrollEl}
        onscroll={updateScrollFades}
      >
        {#if searchMode && searchQuery.trim()}
          {#each searchFields(searchQuery, settingsState.currentSettings) as group (group.sectionKey)}
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
                  onChange={handleChange}
                  onReset={resetToDefault}
                  onPresetSelect={handlePresetSelect}
                />
              {/each}
            </div>
          {:else}
            <div
              class="bg-default-100 rounded-2xl px-4 py-2 text-default-600 text-base"
            >
              No matching settings found.
            </div>
          {/each}
        {:else}
          {#key selectedSettingGroupId}
            {#each SETTINGS_SCHEMA.find((g) => g.id === selectedSettingGroupId)?.sections || [] as section, si}
              <SettingsSection
                {section}
                sectionKey={`${selectedSettingGroupId}-${si}`}
                isExpanded={expandedSections.has(
                  `${selectedSettingGroupId}-${si}`,
                )}
                {monitors}
                {validationErrors}
                onToggle={toggleSection}
                onChange={handleChange}
                onReset={resetToDefault}
                onPresetSelect={handlePresetSelect}
              />
            {/each}
          {/key}
        {/if}
      </div>
      <div
        class="absolute left-0 right-0 bottom-0 h-6 pointer-events-none z-1 bg-gradient-to-t from-neutral-300 dark:from-neutral-600 to-transparent transition-opacity duration-100 {showBottomFade
          ? 'opacity-100'
          : 'opacity-0'}"
      ></div>
    </div>
  </div>

  {#if pendingDownload}
    <DownloadConfirmationModal
      plans={pendingDownload.plans}
      onConfirm={confirmPendingDownload}
      onCancel={cancelPendingDownload}
    />
  {/if}

  <ConfirmModal />
</Bubble>

<style>
  .settings-scroll::-webkit-scrollbar {
    width: 8px;
  }
  .settings-scroll::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }
  .settings-scroll::-webkit-scrollbar-thumb {
    background: oklch(92.2% 0 0);
    border-radius: 4px;
  }
  .settings-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.25);
  }
  :global(html.dark) .settings-scroll::-webkit-scrollbar-thumb {
    background: oklch(30% 0 0);
  }
  :global(html.dark) .settings-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.25);
  }
</style>
