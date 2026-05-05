<script lang="ts">
  import { downloadsState } from "../../state";
  import CollapsibleLabel from "../CollapsibleLabel.svelte";

  let { collapsed } = $props<{ collapsed: boolean }>();

  const isActive = $derived(downloadsState.active.length > 0);
  const badgeCount = $derived(downloadsState.badgeCount);
  const showDoneBadge = $derived(
    !isActive && downloadsState.hasUnseenCompleted,
  );
  const label = $derived(isActive ? "Downloading..." : "Downloads");
</script>

<button
  class="hover:cursor-pointer flex items-center h-8 pl-1.5 {collapsed
    ? 'pr-0'
    : 'pr-2.5'} gap-1.5 rounded-medium transition-[padding,colors,background-color] duration-200 text-default-500 hover:text-default-700 hover:bg-default-200"
  onclick={() => downloadsState.openModal()}
  title={collapsed ? label : undefined}
  aria-label={label}
>
  <span class="relative flex shrink-0">
    <i
      class="flex text-xl {isActive
        ? 'i-line-md-downloading-loop'
        : 'i-material-symbols-downloading-rounded'}"
    ></i>
    {#if badgeCount > 0}
      <span
        class="absolute -top-1 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-default-900 text-default-100 leading-none flex items-center justify-center font-medium"
        style="font-size: 0.625rem;"
      >
        {badgeCount}
      </span>
    {:else if showDoneBadge}
      <span
        class="absolute -top-1 -right-1.5 w-4 h-4 rounded-full bg-accent-green-500 text-white flex items-center justify-center"
        title="Downloads finished"
      >
        <i class="flex i-material-symbols-check-rounded text-xs"></i>
      </span>
    {/if}
  </span>
  <CollapsibleLabel {collapsed} class="text-base text-left">
    {label}
  </CollapsibleLabel>
</button>
