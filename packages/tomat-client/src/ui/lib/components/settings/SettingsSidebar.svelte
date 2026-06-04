<script lang="ts">
  import { SETTINGS_SCHEMA, isGroupVisible } from "@tomat/shared";
  import type { ServerStatus, ServerStatusUpdate } from "$lib/shared/types";
  import { settingsState } from "../../state";
  import { connectionState } from "$lib/state/connection.svelte";
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

</script>

<div class="tomat-scroll flex flex-col gap-2 overflow-y-auto justify-between">
  <div class="flex flex-col gap-1">
    <!-- h-7 (matches the sticky group header) so the icon's vertical center
         lines up with the h2 text when the panel is scrolled to the top. -->
    <button
      class="hover:cursor-pointer text-default-500 hover:text-default-700 hover:bg-surface-inset w-fit flex items-center gap-2 h-6.5 pl-1.5 pr-1.5 rounded-medium transition-colors"
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

    {#each visibleGroups as group (group.id)}
      {@const isActive = selectedGroupId === group.id}
      <SidebarItem
        icon={isActive ? group.icon : (group.iconInactive ?? group.icon)}
        label={group.name}
        {collapsed}
        selected={isActive}
        disabled={connectionState.reconnecting && group.destination === "core"}
        title={collapsed ? group.name : undefined}
        ariaLabel={group.name}
        onclick={() => onSelect?.(group.id)}
      />
    {/each}
  </div>

  <div class="flex flex-col gap-1.5">
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
