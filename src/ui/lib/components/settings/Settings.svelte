<script lang="ts">
  import { onMount } from "svelte";
  import { SETTINGS_SCHEMA } from "$lib/shared/settings";
  import type { PresetOption } from "$lib/shared/settings";
  import type { Monitor } from "$lib/shared/types";
  import Bubble from "../Bubble.svelte";
  import { settingsState, serversState } from "../../state";
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
  import { BASE_MS, getDuration, searchSlide } from "$lib/shared/animations";

  // Sub-components
  import SettingsSidebar from "./SettingsSidebar.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsField from "./SettingsField.svelte";
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
  // Direction the slide animation runs: "up" when entering search (search
  // results live conceptually above the group list), "down" when exiting.
  let searchDirection = $state<"up" | "down">("up");

  function setSearchMode(active: boolean) {
    if (searchMode === active) return;
    // Pin the outgoing wrapper with position:absolute so the incoming wrapper
    // gets its natural place in flow; otherwise both occupy flex space and
    // the slide animation has the panel double in height mid-transition.
    const outgoing = fieldsContainerEl
      ?.firstElementChild as HTMLElement | null;
    if (outgoing) {
      outgoing.style.top = `${outgoing.offsetTop}px`;
      outgoing.style.left = `${outgoing.offsetLeft}px`;
      outgoing.style.width = `${outgoing.offsetWidth}px`;
      outgoing.style.position = "absolute";
    }
    searchDirection = active ? "up" : "down";
    searchMode = active;
  }
  let searchInput: HTMLInputElement | undefined = $state();
  let scrollEl: HTMLDivElement | undefined = $state();
  let scrollViewportHeight = $state(0);
  let fieldsContainerEl: HTMLDivElement | undefined = $state();
  let showBottomFade = $state(true);
  let pendingDownload = $state<null | {
    plans: DownloadPlan[];
    apply: () => Promise<void>;
  }>(null);

  // Refs to each rendered group section, used by the scroll spy and the
  // sidebar bookmark scrollTo. Keyed by group id.
  const groupRefs: Record<string, HTMLElement | undefined> = $state({});
  // Set briefly during programmatic scrollTo so the IntersectionObserver
  // doesn't flicker selectedSettingGroupId through every group on the way down.
  let isProgrammaticScroll = $state(false);
  let containerWidth = $state(0);

  const showAdvanced = $derived(
    !!settingsState.currentSettings["appearance.settings.showAdvanced"],
  );
  const horizontalThreshold = $derived(
    (settingsState.currentSettings[
      "appearance.settings.horizontalThreshold"
    ] as number) ?? 680,
  );
  const horizontal = $derived(containerWidth >= horizontalThreshold);

  const visibleGroups = $derived(
    SETTINGS_SCHEMA.filter((g) => isGroupVisible(g, showAdvanced)),
  );

  function handleSidebarSelect(groupId: string) {
    if (searchMode) {
      searchQuery = "";
      setSearchMode(false);
      // Defer scroll until after the search-slide swap remounts the group
      // list so groupRefs are populated again.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => scrollTo(groupId)),
      );
    } else {
      scrollTo(groupId);
    }
  }

  function scrollTo(groupId: string) {
    const el = groupRefs[groupId];
    if (!el || !scrollEl) return;
    const animEnabled =
      !!settingsState.currentSettings["appearance.animationsEnabled"];
    isProgrammaticScroll = true;
    scrollEl.scrollTo({
      top: el.offsetTop,
      behavior: animEnabled ? "smooth" : "instant",
    });
    selectedSettingGroupId = groupId;
    // 'scrollend' would be more precise but Safari/WebKit support is uneven;
    // fall back to a fixed timeout that comfortably covers a smooth scroll.
    setTimeout(() => {
      isProgrammaticScroll = false;
    }, 600);
  }

  function updateScrollFades() {
    if (!scrollEl) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    showBottomFade = scrollTop + clientHeight < scrollHeight - 1;
  }

  // Scroll spy: the active group is the last one whose header has reached
  // (or passed) the top of the scroll viewport. A scroll listener gives
  // pixel-precise activation; IntersectionObserver's rootMargin tricks
  // produced visible lag at section boundaries.
  function updateActiveGroup() {
    if (isProgrammaticScroll || searchMode || !scrollEl) return;
    const scrollTop = scrollEl.scrollTop;
    let active = visibleGroups[0]?.id;
    for (const group of visibleGroups) {
      const el = groupRefs[group.id];
      if (!el) continue;
      // 1px buffer absorbs sub-pixel rounding when scrolling smoothly.
      if (el.offsetTop <= scrollTop + 1) {
        active = group.id;
      } else {
        break;
      }
    }
    if (active && active !== selectedSettingGroupId) {
      selectedSettingGroupId = active;
    }
  }

  function onScroll() {
    updateScrollFades();
    updateActiveGroup();
  }

  // Container width watcher driving horizontal-mode flip.
  $effect(() => {
    if (!fieldsContainerEl) return;
    const ro = new ResizeObserver((entries) => {
      containerWidth = entries[0].contentRect.width;
    });
    ro.observe(fieldsContainerEl);
    return () => ro.disconnect();
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

      mapped.sort((a, b) =>
        a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
      );
      monitors = mapped;
    } catch (e) {
      console.error("Failed to load monitors:", e);
    }
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
        const apply = async () => {
          await tryApply(key, value);
        };
        pendingDownload = { plans, apply };
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
    settingsState.currentSettings = { ...settingsState.currentSettings };
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

  // Captures the topmost field/group anchor before a layout-shifting change
  // (sidebar collapse, advanced-fields toggle), runs the change, then re-pins
  // the same anchor to its previous viewport offset every frame for the full
  // animation window.
  //
  // A single tick-and-scroll isn't enough: the sidebar's slide transition
  // animates over ~200ms and the ResizeObserver-driven horizontal-mode flip
  // fires partway through, both of which keep shifting the anchor's
  // offsetTop after our first measurement. Re-pinning per frame tracks the
  // anchor through the whole settle process.
  //
  // Each frame we walk a fallback chain (field → enclosing group) so that if
  // the field gets unmounted (e.g. it was advanced and the toggle just hid
  // it), we still pin to its containing group's top instead of letting the
  // browser clamp scrollTop to the now-shorter content's bottom.
  type AnchorEntry = { selector: string; offset: number };

  function withScrollAnchor(fn: () => void) {
    if (!scrollEl) {
      fn();
      return;
    }

    const scrollTop = scrollEl.scrollTop;
    const candidates = scrollEl.querySelectorAll<HTMLElement>(
      "[data-field-id], [data-group-id]",
    );
    let topAnchor: HTMLElement | null = null;
    for (const el of candidates) {
      if (el.offsetTop >= scrollTop) {
        topAnchor = el;
        break;
      }
    }

    const chain: AnchorEntry[] = [];
    if (topAnchor) {
      const offset = topAnchor.offsetTop - scrollTop;
      const fid = topAnchor.dataset.fieldId;
      const gid = topAnchor.dataset.groupId;
      if (fid) {
        chain.push({
          selector: `[data-field-id="${CSS.escape(fid)}"]`,
          offset,
        });
        // Fallback 1: the enclosing section. Pinned at offset 0 so its top
        // edge (with the sticky section header) lands at the viewport top,
        // keeps the user "in the same section" when only their specific
        // field has been hidden.
        const sectionAncestor = topAnchor.closest<HTMLElement>(
          "[data-section-key]",
        );
        if (sectionAncestor?.dataset.sectionKey) {
          chain.push({
            selector: `[data-section-key="${CSS.escape(sectionAncestor.dataset.sectionKey)}"]`,
            offset: 0,
          });
        }
        // Fallback 2: the enclosing group. Used when the entire section is
        // also gone (whole section marked advanced, or all of its fields
        // are advanced).
        const groupAncestor =
          topAnchor.closest<HTMLElement>("[data-group-id]");
        if (groupAncestor?.dataset.groupId) {
          chain.push({
            selector: `[data-group-id="${CSS.escape(groupAncestor.dataset.groupId)}"]`,
            offset: 0,
          });
        }
      } else if (gid) {
        chain.push({
          selector: `[data-group-id="${CSS.escape(gid)}"]`,
          offset,
        });
      }
    }

    fn();

    if (chain.length === 0) return;

    // Run a buffered window: full animation duration + 100ms grace so the
    // post-transition ResizeObserver tick (and any horizontal-mode flip it
    // triggers) have time to land.
    const deadline = performance.now() + getDuration(BASE_MS) + 100;

    function step() {
      if (!scrollEl) return;
      for (const entry of chain) {
        const el = scrollEl.querySelector<HTMLElement>(entry.selector);
        if (!el) continue;
        const target = Math.max(0, el.offsetTop - entry.offset);
        // Skip the assignment when we're already there to avoid spurious
        // scroll events stealing focus from a user-initiated scroll.
        if (Math.abs(scrollEl.scrollTop - target) > 0.5) {
          scrollEl.scrollTop = target;
        }
        break;
      }
      if (performance.now() < deadline) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  function onSearchInput() {
    if (searchQuery.trim()) {
      setSearchMode(true);
    } else if (searchMode) {
      setSearchMode(false);
    }
  }
</script>

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  extraClass="flex flex-col gap-3 overflow-hidden transition-all w-full h-80vh relative"
>
  <!-- Settings Header and Back Button -->
  <div class="flex gap-2 items-center text-2xl relative">
    <div
      class="relative h-10 bg-default-200 rounded-2xl overflow-hidden w-full flex items-center px-4 pr-8"
    >
      <input
        type="text"
        placeholder="Search settings..."
        class="bg-transparent outline-none text-base text-default-600 w-full"
        bind:this={searchInput}
        bind:value={searchQuery}
        oninput={onSearchInput}
        onfocus={() => {
          if (searchQuery.trim() && !searchMode) {
            setSearchMode(true);
          }
        }}
      />
      {#if searchQuery}
        <button
          class="flex absolute right-3 top-1/2 -translate-y-1/2 text-default-400 hover:text-default-600 text-lg cursor-pointer transition-colors"
          onclick={() => {
            searchQuery = "";
            setSearchMode(false);
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
      selectedGroupId={selectedSettingGroupId}
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
        bind:this={scrollEl}
        bind:clientHeight={scrollViewportHeight}
        onscroll={onScroll}
      >
        <div bind:this={fieldsContainerEl} class="relative">
          {#key searchMode}
            <div
              in:searchSlide={{ direction: searchDirection, phase: "in" }}
              out:searchSlide={{ direction: searchDirection, phase: "out" }}
            >
              {#if searchMode && searchQuery.trim()}
                <div class="flex flex-col gap-4">
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
                          {horizontal}
                          onChange={handleChange}
                          onReset={resetToDefault}
                          onPresetSelect={handlePresetSelect}
                        />
                      {/each}
                    </div>
                  {:else}
                    <div
                      class="bg-default-200 rounded-2xl px-4 py-2 text-default-600 text-base"
                    >
                      No matching settings found.
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="flex flex-col gap-4">
                  {#each visibleGroups as group, gi (group.id)}
                    {@const isLast = gi === visibleGroups.length - 1}
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
                      bind:this={groupRefs[group.id]}
                      class="flex flex-col"
                      style={isLast && scrollViewportHeight
                        ? `min-height: ${scrollViewportHeight}px`
                        : undefined}
                    >
                      <div class="sticky top-0 z-20">
                        <h2
                          class="flex items-center h-7 bg-default-300 text-sm text-default-800 font-medium uppercase tracking-wide"
                        >
                          {group.name}
                        </h2>
                        <div
                          class="absolute left-0 right-0 top-full h-3 bg-gradient-to-b from-neutral-300 dark:from-neutral-600 to-neutral-300/0 dark:to-neutral-600/0 pointer-events-none"
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
                              {horizontal}
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
          {/key}
        </div>
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
    background: oklch(37% 0 0);
  }
  :global(html.dark) .settings-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.25);
  }
</style>
