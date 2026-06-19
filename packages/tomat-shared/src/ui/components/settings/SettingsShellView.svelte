<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import Bubble from "../primitives/Bubble.svelte";
  import SettingsHeaderView from "./SettingsHeaderView.svelte";
  import SettingsSidebarView from "./SettingsSidebarView.svelte";
  import { slideSwap } from "../../animations.ts";
  import { useUiContext } from "../../context.ts";

  const noop = (): void => {};

  // A focused, reusable settings panel: a collapsible group sidebar beside a
  // scrollable content area that shows either the selected group's fields or
  // search results, with the app's vertical group-swap slide. Composed entirely
  // from the shared primitives so it renders identically to the client settings
  // UI. The website showcase drives it via the exported `selectGroup` /
  // `setSearch`; a future manual page can render a single group statically.
  const ui = useUiContext();

  type Group = { id: string; name: string; icon: string; iconInactive?: string };

  let {
    groups,
    selectedGroupId = $bindable(groups[0]?.id ?? ""),
    sidebarCollapsed = $bindable(false),
    searchValue = $bindable(""),
    searchMode = $bindable(false),
    searchEl = $bindable<HTMLInputElement | undefined>(undefined),
    searchPlaceholder = "Search settings...",
    searchDisabled = false,
    onSearchInput,
    onSearchFocus,
    onSearchClear,
    onQuickSettings = noop,
    onShare = noop,
    onClose = noop,
    isGroupDisabled,
    onReselectGroup,
    onToggleSidebar,
    sizeClass = "w-[760px] max-w-[calc(100vw-5rem)] h-80vh",
    belowHeader,
    groupContent,
    searchContent,
    sidebarFooter,
  }: {
    groups: Group[];
    selectedGroupId?: string;
    sidebarCollapsed?: boolean;
    searchValue?: string;
    searchMode?: boolean;
    searchEl?: HTMLInputElement;
    searchPlaceholder?: string;
    searchDisabled?: boolean;
    onSearchInput?: (v: string) => void;
    onSearchFocus?: (e: FocusEvent) => void;
    onSearchClear?: () => void;
    onQuickSettings?: () => void;
    onShare?: () => void;
    onClose?: () => void;
    isGroupDisabled?: (id: string) => boolean;
    /** Fired when the already-selected group is re-clicked (no slide). The
     *  client uses it to restore that group's default section expand state. */
    onReselectGroup?: (id: string) => void;
    /** Overrides the sidebar collapse toggle. When omitted, `sidebarCollapsed`
     *  is toggled internally; the client passes this to persist it as a setting
     *  (with scroll anchoring). */
    onToggleSidebar?: () => void;
    /** Sizing for the panel Bubble (default: the app's 760px x 80vh). */
    sizeClass?: string;
    /** Rendered between the header row and the sidebar/content split (e.g. the
     *  multi-core picker). */
    belowHeader?: Snippet;
    /** Renders the fields for a group id. */
    groupContent: Snippet<[string]>;
    /** Renders the search results. */
    searchContent?: Snippet;
    /** Pinned bottom of the sidebar (status chips, Downloads, version). The
     *  boolean is the current collapsed state, so rows can collapse to icons. */
    sidebarFooter?: Snippet<[boolean]>;
  } = $props();

  let layerEl: HTMLDivElement | undefined = $state();
  let scrollEl: HTMLDivElement | undefined = $state();
  let showTopFade = $state(false);
  let showBottomFade = $state(false);
  let transitioning = false;

  function updateFades(): void {
    const el = scrollEl;
    if (!el) return;
    showTopFade = el.scrollTop > 1;
    showBottomFade = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  /** Slide to a group (or out of search). Vertical swap mirroring the app. */
  export async function selectGroup(id: string): Promise<void> {
    if (transitioning) return;
    // Re-clicking the active group (when not searching) is not a slide; let the
    // client restore that group's default section state instead.
    if (id === selectedGroupId && !searchMode) {
      onReselectGroup?.(id);
      return;
    }
    transitioning = true;
    const fromIdx = searchMode ? -1 : groups.findIndex((g) => g.id === selectedGroupId);
    const toIdx = groups.findIndex((g) => g.id === id);
    // Earlier group leaves upward (outSign 1), later group downward.
    const outSign: 1 | -1 = toIdx < fromIdx ? 1 : -1;
    await slideSwap(layerEl, {
      axis: "y",
      outSign,
      durationMs: ui.animationDurationMs(),
      swap: async () => {
        searchMode = false;
        searchValue = "";
        selectedGroupId = id;
        await tick();
        if (scrollEl) scrollEl.scrollTop = 0;
        updateFades();
      },
    });
    transitioning = false;
  }

  /** Enter or leave search-results mode with the same vertical swap. */
  export async function setSearch(active: boolean): Promise<void> {
    if (transitioning || searchMode === active) return;
    transitioning = true;
    await slideSwap(layerEl, {
      axis: "y",
      outSign: active ? 1 : -1,
      durationMs: ui.animationDurationMs(),
      swap: async () => {
        searchMode = active;
        await tick();
        if (scrollEl) scrollEl.scrollTop = 0;
        updateFades();
      },
    });
    transitioning = false;
  }

  /** The scroll viewport, so a caller can animate `scrollTop`. */
  export function getScrollEl(): HTMLDivElement | undefined {
    return scrollEl;
  }

  /** Snap back to the initial state with NO animation (used by the showcase when
   *  re-locking a stage to time 0). Synchronous, so it never collides with the
   *  `transitioning` guard the way replaying `selectGroup`/`setSearch` would. */
  export function reset(): void {
    transitioning = false;
    searchMode = false;
    searchValue = "";
    selectedGroupId = groups[0]?.id ?? "";
    if (layerEl) {
      layerEl.style.transition = "";
      layerEl.style.transform = "";
    }
    if (scrollEl) scrollEl.scrollTop = 0;
    showTopFade = false;
    showBottomFade = false;
  }
</script>

<Bubble
  selectedAlignment={ui.getAlignment()}
  extraClass="flex flex-col gap-3 overflow-hidden {sizeClass} relative"
>
  <SettingsHeaderView
    bind:searchValue
    bind:searchEl
    {searchPlaceholder}
    {searchDisabled}
    {onSearchInput}
    {onSearchFocus}
    {onSearchClear}
    {onQuickSettings}
    {onShare}
    {onClose}
  />

  {#if belowHeader}
    {@render belowHeader()}
  {/if}

  <div class="flex flex-1 overflow-hidden min-h-0 -mr-2 gap-3">
    <!-- Sidebar -->
    <SettingsSidebarView
      {groups}
      {selectedGroupId}
      {searchMode}
      collapsed={sidebarCollapsed}
      onToggleCollapse={onToggleSidebar ?? (() => (sidebarCollapsed = !sidebarCollapsed))}
      onSelectGroup={selectGroup}
      {isGroupDisabled}
      footer={sidebarFooter}
    />

    <!-- Content -->
    <div class="relative flex-1 min-h-0 min-w-0">
      <div
        class="tomat-scroll overflow-y-auto pr-2 h-full"
        bind:this={scrollEl}
        onscroll={updateFades}
        data-demo="content"
      >
        <div bind:this={layerEl}>
          {#if searchMode}
            {@render searchContent?.()}
          {:else}
            {@render groupContent(selectedGroupId)}
          {/if}
        </div>
      </div>
      <div
        class="absolute left-0 right-0 top-0 h-6 pointer-events-none z-1 bg-gradient-to-b from-default-50 to-transparent transition-opacity duration-100 {showTopFade &&
        searchMode
          ? 'opacity-100'
          : 'opacity-0'}"
      ></div>
      <div
        class="absolute left-0 right-0 bottom-0 h-6 pointer-events-none z-1 bg-gradient-to-t from-default-50 to-transparent transition-opacity duration-100 {showBottomFade
          ? 'opacity-100'
          : 'opacity-0'}"
      ></div>
    </div>
  </div>
</Bubble>
