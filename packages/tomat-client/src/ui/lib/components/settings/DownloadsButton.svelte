<script lang="ts">
  import { downloadsState } from "../../state";
  import SidebarItem from "../ui/SidebarItem.svelte";

  let { collapsed } = $props<{ collapsed: boolean }>();

  const isActive = $derived(downloadsState.active.length > 0);
  const badgeCount = $derived(downloadsState.badgeCount);
  const showDoneBadge = $derived(
    !isActive && downloadsState.hasUnseenCompleted,
  );
  const label = $derived(isActive ? "Downloading..." : "Downloads");
</script>

<SidebarItem
  icon={isActive
    ? "i-line-md-downloading-loop"
    : "i-material-symbols-downloading-rounded"}
  {label}
  {collapsed}
  title={collapsed ? label : undefined}
  ariaLabel={label}
  onclick={() => downloadsState.openModal()}
>
  {#snippet badge()}
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
  {/snippet}
</SidebarItem>
