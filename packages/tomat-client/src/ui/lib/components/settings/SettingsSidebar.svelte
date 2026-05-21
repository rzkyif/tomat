<script lang="ts">
  import { SETTINGS_SCHEMA, isGroupVisible } from "@tomat/shared";
  import type { ServerStatus, ServerStatusUpdate } from "$lib/shared/types";
  import { settingsState } from "../../state";
  import ServerStatusChip from "./ServerStatusChip.svelte";
  import DownloadsButton from "./DownloadsButton.svelte";
  import CollapsibleLabel from "../CollapsibleLabel.svelte";

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

  const showAdvanced = $derived(
    !!settingsState.currentSettings["appearance.settings.showAdvanced"],
  );
  const collapsed = $derived(
    !!settingsState.currentSettings["appearance.settings.sidebarCollapsed"],
  );

  const visibleGroups = $derived(
    SETTINGS_SCHEMA.filter((g) => isGroupVisible(g, showAdvanced)),
  );

  function toggleAdvanced() {
    withScrollAnchor(() => {
      settingsState.updateSetting(
        "appearance.settings.showAdvanced",
        !showAdvanced,
      );
    });
  }

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
    Disabled: "bg-default-200",
    Error: "bg-accent-red-200",
    Loading: "bg-accent-orange-200",
    Running: "bg-accent-green-200",
  };

  // Gap matches pl-1.5 so the space between icon and label mirrors the icon's
  // left inset and stays constant across the collapse. The label width and
  // the trailing pr-2.5 collapse together so the row reduces to a centred
  // icon (pl-1.5 + icon + gap-1.5 with empty label + pr-0). Icon-only rows
  // skip the trailing-pad collapse to stay symmetric rectangles.
  function rowClass(hasText: boolean): string {
    const showText = hasText && !collapsed;
    const padRight = hasText ? (showText ? "pr-2.5" : "pr-0") : "pr-1.5";
    return `flex items-center h-8 pl-1.5 ${padRight} gap-1.5 rounded-medium transition-[padding,colors,background-color] duration-200`;
  }

</script>

<div class="flex flex-col gap-2 overflow-y-auto justify-between">
  <div class="flex flex-col gap-1">
    <!-- h-7 (matches the sticky group header) so the icon's vertical center
         lines up with the h2 text when the panel is scrolled to the top. -->
    <button
      class="hover:cursor-pointer text-default-500 hover:text-default-700 hover:bg-default-200 w-fit flex items-center gap-2 h-6.5 pl-1.5 pr-1.5 rounded-medium transition-colors"
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
      <button
        class="hover:cursor-pointer {rowClass(true)} {isActive
          ? 'bg-default-300 text-default-900'
          : 'text-default-500 hover:text-default-700 hover:bg-default-200'}"
        onclick={() => onSelect?.(group.id)}
        title={collapsed ? group.name : undefined}
        aria-label={group.name}
      >
        <i
          class="flex text-xl shrink-0 {isActive
            ? group.icon
            : (group.iconInactive ?? group.icon)}"
        ></i>
        <CollapsibleLabel {collapsed} class="text-base text-left">
          {group.name}
        </CollapsibleLabel>
      </button>
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

    <DownloadsButton {collapsed} />

    <button
      class="hover:cursor-pointer {rowClass(true)} {showAdvanced
        ? 'bg-default-300 text-default-900'
        : 'text-default-500 hover:text-default-700 hover:bg-default-200'}"
      onclick={toggleAdvanced}
      title={collapsed
        ? showAdvanced
          ? "Hide advanced fields"
          : "Show advanced fields"
        : undefined}
      aria-pressed={showAdvanced}
    >
      <i
        class="flex text-xl shrink-0 {showAdvanced
          ? 'i-material-symbols-toggle-on'
          : 'i-material-symbols-toggle-off-outline'}"
      ></i>
      <CollapsibleLabel {collapsed} class="text-base text-left">
        Advanced Fields
      </CollapsibleLabel>
    </button>

    <div
      class="flex items-center {rowClass(false)} text-default-900 select-none"
    >
      <span
        class="w-5 h-5 bg-current shrink-0"
        style="mask:url(/tomat.svg) center/contain no-repeat;-webkit-mask:url(/tomat.svg) center/contain no-repeat;"
        aria-label="tomat"
      ></span>
    </div>
  </div>
</div>
