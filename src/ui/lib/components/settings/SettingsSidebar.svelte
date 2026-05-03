<script lang="ts">
  import { slide } from "svelte/transition";
  import { SETTINGS_SCHEMA, isGroupVisible } from "$lib/shared/settings";
  import type { ServerStatus, ServerStatusUpdate } from "$lib/shared/types";
  import { settingsState } from "../../state";
  import { getDuration } from "$lib/shared/animations";
  import ServerStatusChip from "./ServerStatusChip.svelte";

  let {
    selectedGroupId,
    onSelect,
    llmStatus,
    sttStatus,
    bunStatus,
    withScrollAnchor,
  } = $props<{
    selectedGroupId: string;
    onSelect?: (id: string) => void;
    llmStatus: ServerStatusUpdate;
    sttStatus: ServerStatusUpdate;
    bunStatus: ServerStatusUpdate;
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
    Downloading: "bg-accent-blue-200",
    Loading: "bg-accent-orange-200",
    Running: "bg-accent-green-200",
  };

  // Left padding stays constant so icons line up at the same X position in
  // both modes. Right padding is only widened when the row actually has a
  // text label next to its icon. Icon-only rows stay compact rectangles.
  function rowClass(hasText: boolean): string {
    const showText = hasText && !collapsed;
    return `flex items-center gap-2 h-8 pl-1.5 ${showText ? "pr-2.5" : "pr-1.5"} rounded-lg transition-[padding,colors,background-color] duration-200`;
  }

  // Text spans use Svelte's slide transition with axis "x" so the sidebar
  // resizes smoothly as labels appear/disappear. Duration honours the
  // appearance.animations* settings via getDuration().
  const slideX = $derived({ axis: "x" as const, duration: getDuration() });
</script>

<div class="flex flex-col gap-2 overflow-y-auto justify-between">
  <div class="flex flex-col gap-1">
    <!-- h-7 (matches the sticky group header) so the icon's vertical center
         lines up with the h2 text when the panel is scrolled to the top. -->
    <button
      class="hover:cursor-pointer text-default-500 hover:text-default-700 hover:bg-default-200 w-fit flex items-center gap-2 h-6.5 pl-1.5 pr-1.5 rounded-lg transition-colors"
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
        {#if !collapsed}
          <span
            transition:slide={slideX}
            class="text-base text-left whitespace-nowrap"
          >
            {group.name}
          </span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="flex flex-col gap-1.5">
    {#if collapsed}
      {#if chipVisible(llmStatus.status as ServerStatus) || chipVisible(sttStatus.status as ServerStatus) || chipVisible(bunStatus.status as ServerStatus)}
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
          {#if chipVisible(bunStatus.status as ServerStatus)}
            <span
              class="w-3 h-3 rounded-full {chipBgMap[
                bunStatus.status as ServerStatus
              ]}"
              title={"Bun: " + bunStatus.status}
            ></span>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="flex flex-col gap-1.5 text-sm font-medium w-full">
        <ServerStatusChip type="LLM" update={llmStatus} />
        <ServerStatusChip type="STT" update={sttStatus} />
        <ServerStatusChip type="Bun" update={bunStatus} />
      </div>
    {/if}

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
      {#if !collapsed}
        <span
          transition:slide={slideX}
          class="text-base text-left whitespace-nowrap"
        >
          Advanced Fields
        </span>
      {/if}
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
