<script lang="ts">
  import { downloadsState } from "../../state";
  import { useBlink } from "$composables/use-blink.svelte";
  import SidebarItem from "@tomat/shared/ui/components/primitives/SidebarItem.svelte";

  let { collapsed, disabled = false } = $props<{
    collapsed: boolean;
    disabled?: boolean;
  }>();

  // Until the user approves the missing files, the button is in pending mode:
  // clicking re-opens the Pending Downloads modal. Once approved (downloads
  // enqueued) it flips to download-manager mode so the running queue is
  // reachable, even though the app stays gated until the files land.
  const isPending = $derived(downloadsState.needsApproval);
  const isActive = $derived(!isPending && downloadsState.active.length > 0);
  const label = $derived(
    isPending ? "Pending Downloads" : isActive ? "Downloading..." : "Downloads",
  );
  const icon = $derived(
    isActive
      ? "i-line-md-downloading-loop"
      : "i-material-symbols-downloading-rounded",
  );

  // Ping while there's something to act on: accent-yellow when setup is pending,
  // grey while a queue is active (the label says which); idle stays quiet.
  // Interval matches SidebarItem's 500ms color transition (no flat hold).
  const blink = useBlink();
  $effect(() => blink.run(isPending || isActive));

  function onClick() {
    if (isPending) downloadsState.requestRequiredModal();
    else downloadsState.openModal();
  }
</script>

<SidebarItem
  {icon}
  {label}
  {collapsed}
  {disabled}
  ping={blink.on}
  pingTone={isPending ? "accent" : "default"}
  title={collapsed ? label : undefined}
  ariaLabel={label}
  onclick={onClick}
/>
