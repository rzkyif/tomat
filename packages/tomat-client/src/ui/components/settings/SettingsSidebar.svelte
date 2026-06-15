<script lang="ts">
  import { onMount } from "svelte";
  import { groupDestinations, SETTINGS_SCHEMA, isGroupVisible } from "@tomat/shared";
  import type { ServerStatus, ServerStatusUpdate } from "$lib/util/types";
  import { settingsState } from "../../state";
  import { connectionState } from "$stores/connection.svelte";
  import { useSettingsScroll } from "$composables/use-settings-scroll.svelte";
  import ServerStatusChip from "./ServerStatusChip.svelte";
  import DownloadsButton from "./DownloadsButton.svelte";
  import UpdateButton from "./UpdateButton.svelte";
  import SidebarItem from "../ui/SidebarItem.svelte";

  let {
    selectedGroupId,
    onSelect,
    llmStatus,
    sttStatus,
    ttsStatus,
    withScrollAnchor,
  } = $props<{
    selectedGroupId: string;
    onSelect?: (id: string) => void;
    llmStatus: ServerStatusUpdate;
    sttStatus: ServerStatusUpdate;
    ttsStatus: ServerStatusUpdate;
    /** Wrap a layout-shifting state change so the scroll panel preserves
     *  the anchor field's viewport position across the toggle. */
    withScrollAnchor: (fn: () => void) => void;
  }>();

  const collapsed = $derived(
    !!settingsState.currentSettings["appearance.settings.sidebarCollapsed"],
  );

  const visibleGroups = $derived(SETTINGS_SCHEMA.filter((g) => isGroupVisible(g)));

  function toggleCollapse() {
    withScrollAnchor(() => {
      settingsState.updateSetting(
        "appearance.settings.sidebarCollapsed",
        !collapsed,
      );
    });
  }

  // ServerStatusChip only renders when status is not Running and not Disabled.
  // In collapsed mode we mirror that condition for the dot indicator.
  function chipVisible(status: ServerStatus): boolean {
    return status !== "Running" && status !== "Disabled";
  }

  // Mirrors the bg half of ServerStatusChip's colorMap so collapsed dots
  // share their expanded-chip colour.
  const chipBgMap: Record<ServerStatus, string> = {
    Disabled: "bg-surface-inset",
    Error: "bg-accent-red-200",
    Loading: "bg-accent-yellow-200",
    Running: "bg-accent-green-200",
  };

  // Only the group-link list scrolls; its own top/bottom fades (mirroring the
  // main panel). Collapse only changes width, not vertical overflow, so fades
  // depend on scroll position + viewport height: refresh on scroll, on resize,
  // and whenever the visible-group set changes (covers mount).
  const scroll = useSettingsScroll();
  $effect(() => {
    void visibleGroups.length;
    scroll.updateFades();
  });
  onMount(() => {
    const onResize = () => scroll.updateFades();
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  });
</script>

<div class="flex flex-col gap-2 h-full min-h-0">
  <!-- h-6.5 (matches the sticky group header) so the icon's vertical center
       lines up with the h2 text when the panel is scrolled to the top. Pinned
       above the scrolling link list. -->
  <button
    class="shrink-0 hover:cursor-pointer text-default-500 hover:text-default-700 hover:bg-surface-inset w-fit flex items-center gap-2 h-6.5 pl-1.5 pr-1.5 rounded-medium transition-colors"
    onclick={toggleCollapse}
    title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
  >
    <i
      class="flex text-xl shrink-0 {collapsed
        ? 'i-material-symbols-keyboard-double-arrow-right-rounded'
        : 'i-material-symbols-keyboard-double-arrow-left-rounded'}"
    ></i>
  </button>

  <!-- The only scrollable area: the group-link list, with top/bottom fades.
       pr-2 keeps the scrollbar off the items (matches the main panel). -->
  <div class="relative flex-1 min-h-0">
    <div
      bind:this={scroll.scrollEl}
      onscroll={() => scroll.updateFades()}
      class="tomat-scroll h-full overflow-y-auto pr-2"
    >
      <div class="flex flex-col">
        {#each visibleGroups as group (group.id)}
          {@const isActive = selectedGroupId === group.id}
          <SidebarItem
            icon={isActive ? group.icon : (group.iconInactive ?? group.icon)}
            label={group.name}
            {collapsed}
            selected={isActive}
            disabled={connectionState.reconnecting &&
              groupDestinations(group).length === 1 &&
              groupDestinations(group)[0] === "core"}
            title={collapsed ? group.name : undefined}
            ariaLabel={group.name}
            onclick={() => onSelect?.(group.id)}
          />
        {/each}
      </div>
    </div>
    <div
      class="absolute left-0 right-0 top-0 h-6 pointer-events-none z-1 bg-gradient-to-b from-default-50 to-transparent transition-opacity duration-100 {scroll.showTopFade
        ? 'opacity-100'
        : 'opacity-0'}"
    ></div>
    <div
      class="absolute left-0 right-0 bottom-0 h-6 pointer-events-none z-1 bg-gradient-to-t from-default-50 to-transparent transition-opacity duration-100 {scroll.showBottomFade
        ? 'opacity-100'
        : 'opacity-0'}"
    ></div>
  </div>

  <div class="shrink-0 flex flex-col gap-1.5">
    {#if collapsed}
      {#if chipVisible(llmStatus.status as ServerStatus) || chipVisible(sttStatus.status as ServerStatus) || chipVisible(ttsStatus.status as ServerStatus)}
        <div class="flex flex-col gap-1.5 items-center px-1.5 py-1">
          {#if chipVisible(llmStatus.status as ServerStatus)}
            <span
              class="w-3 h-3 rounded-full {chipBgMap[
                llmStatus.status as ServerStatus
              ]}"
              title={"LLM: " + llmStatus.status}
            ></span>
          {/if}
          {#if chipVisible(sttStatus.status as ServerStatus)}
            <span
              class="w-3 h-3 rounded-full {chipBgMap[
                sttStatus.status as ServerStatus
              ]}"
              title={"STT: " + sttStatus.status}
            ></span>
          {/if}
          {#if chipVisible(ttsStatus.status as ServerStatus)}
            <span
              class="w-3 h-3 rounded-full {chipBgMap[
                ttsStatus.status as ServerStatus
              ]}"
              title={"TTS: " + ttsStatus.status}
            ></span>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="flex flex-col gap-1.5 text-sm font-medium w-full">
        <ServerStatusChip type="LLM" update={llmStatus} />
        <ServerStatusChip type="STT" update={sttStatus} />
        <ServerStatusChip type="TTS" update={ttsStatus} />
      </div>
    {/if}

    <DownloadsButton {collapsed} disabled={connectionState.reconnecting} />

    <!-- Versioned update affordance. Shows "tomat client vX.X.X" at rest;
         drives the combined client + core + sidecar update flow on click. -->
    <UpdateButton {collapsed} disabled={connectionState.reconnecting} />
  </div>
</div>
