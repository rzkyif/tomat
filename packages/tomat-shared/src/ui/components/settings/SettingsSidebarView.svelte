<script lang="ts">
  import type { Snippet } from "svelte";
  import SidebarItem from "../primitives/SidebarItem.svelte";

  // THE single settings sidebar for both the client and the website
  // (single-source rule, AGENTS.md): the collapse toggle, the scrollable group
  // list (with top/bottom fades), and a pinned footer slot. The client wraps it
  // feeding live groups + the real footer (status chips, Downloads, version); the
  // website wraps it feeding the schema groups + a static footer.

  type Group = { id: string; name: string; icon: string; iconInactive?: string };

  let {
    groups,
    selectedGroupId,
    searchMode = false,
    collapsed,
    onToggleCollapse,
    onSelectGroup,
    isGroupDisabled,
    footer,
  }: {
    groups: Group[];
    selectedGroupId: string;
    /** When searching, no group is highlighted as selected. */
    searchMode?: boolean;
    collapsed: boolean;
    onToggleCollapse: () => void;
    onSelectGroup: (id: string) => void;
    isGroupDisabled?: (id: string) => boolean;
    /** Pinned bottom of the sidebar; the boolean is the collapsed state. */
    footer?: Snippet<[boolean]>;
  } = $props();

  let scrollEl = $state<HTMLDivElement>();
  let showTopFade = $state(false);
  let showBottomFade = $state(false);
  function updateFades(): void {
    const el = scrollEl;
    if (!el) return;
    showTopFade = el.scrollTop > 1;
    showBottomFade = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
</script>

<div class="flex flex-col gap-2 h-full min-h-0">
  <!-- h-6.5 (matches the sticky group header) so the icon's vertical center lines
       up with the group header text when scrolled to the top. -->
  <button
    class="shrink-0 hov:cursor-pointer text-default-500 hov:text-default-700 hov:bg-surface-inset w-fit flex items-center gap-2 h-6.5 pl-1.5 pr-1.5 rounded-medium transition-colors"
    onclick={onToggleCollapse}
    title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    data-demo="collapse"
  >
    <i
      class="flex text-xl shrink-0 {collapsed
        ? 'i-material-symbols-keyboard-double-arrow-right-rounded'
        : 'i-material-symbols-keyboard-double-arrow-left-rounded'}"
    ></i>
  </button>

  <div class="relative flex-1 min-h-0">
    <div bind:this={scrollEl} onscroll={updateFades} class="tomat-scroll h-full overflow-y-auto pr-2">
      <div class="flex flex-col gap-2">
        {#each groups as g (g.id)}
          {@const selected = !searchMode && selectedGroupId === g.id}
          <SidebarItem
            icon={selected ? g.icon : (g.iconInactive ?? g.icon)}
            label={g.name}
            {collapsed}
            {selected}
            disabled={isGroupDisabled?.(g.id) ?? false}
            title={collapsed ? g.name : undefined}
            ariaLabel={g.name}
            onclick={() => onSelectGroup(g.id)}
            class="settings-group-{g.id}"
          />
        {/each}
      </div>
    </div>
    <div
      class="absolute left-0 right-0 top-0 h-6 pointer-events-none z-1 bg-gradient-to-b from-default-50 to-transparent transition-opacity duration-100 {showTopFade
        ? 'opacity-100'
        : 'opacity-0'}"
    ></div>
    <div
      class="absolute left-0 right-0 bottom-0 h-6 pointer-events-none z-1 bg-gradient-to-t from-default-50 to-transparent transition-opacity duration-100 {showBottomFade
        ? 'opacity-100'
        : 'opacity-0'}"
    ></div>
  </div>

  {#if footer}
    <div class="shrink-0 flex flex-col gap-1.5 pr-2">
      {@render footer(collapsed)}
    </div>
  {/if}
</div>
