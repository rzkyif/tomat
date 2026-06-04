<script lang="ts">
  import { downloadsState } from "../../state";
  import { useBlink } from "$lib/composables/use-blink.svelte";
  import SidebarItem from "../ui/SidebarItem.svelte";

  let { collapsed, disabled = false } = $props<{
    collapsed: boolean;
    disabled?: boolean;
  }>();

  // Pending (required files missing) takes precedence over an in-flight queue:
  // while pending, clicking re-opens the Pending Downloads modal and the
  // download list is intentionally unreachable (accepted drawback).
  const isPending = $derived(downloadsState.hasPending);
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
