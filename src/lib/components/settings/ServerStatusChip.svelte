<script lang="ts">
  import type { ServerStatus, ServerStatusUpdate } from "$lib/shared/types";

  let { type, update } = $props<{
    type: "LLM" | "STT";
    update: ServerStatusUpdate;
  }>();

  let isOpen = $state(false);
  let buttonEl = $state<HTMLButtonElement>();
  let popupStyle = $state("");

  function updatePopupPosition() {
    if (!buttonEl) return;
    const rect = buttonEl.getBoundingClientRect();
    popupStyle = `left: ${rect.left}px; bottom: ${window.innerHeight - rect.top + 8}px;`;
  }

  const colorMap: Record<ServerStatus, string> = {
    Disabled: "bg-chip-neutral text-chip-neutral",
    Error: "bg-chip-red text-chip-red",
    Downloading: "bg-chip-blue text-chip-blue",
    Loading: "bg-chip-amber text-chip-amber",
    Running: "bg-chip-emerald text-chip-emerald",
  };
  const color = $derived(colorMap[update.status as ServerStatus]);

  const iconMap: Record<ServerStatus, string> = {
    Disabled: "i-material-symbols-nearby-off-rounded",
    Error: "i-material-symbols-warning-rounded",
    Downloading: "i-material-symbols-cloud-download-rounded",
    Loading: "i-material-symbols-progress-activity animate-spin",
    Running: "i-material-symbols-check-rounded",
  };
  const icon = $derived(iconMap[update.status as ServerStatus]);

  function toggle() {
    if (update.status === "Error") {
      isOpen = !isOpen;
      if (isOpen) updatePopupPosition();
    }
  }
</script>

{#if update.status !== "Running" && update.status !== "Disabled"}
  <button
    bind:this={buttonEl}
    class="flex items-center gap-1.5 px-3 py-1 rounded-2xl {color} {update.status ===
    'Error'
      ? 'cursor-pointer hover:ring-2 ring-red-400/50'
      : 'cursor-default'}"
    title={update.status !== "Error"
      ? update.message || update.status
      : undefined}
    onclick={(e) => {
      toggle();
      e.stopPropagation();
    }}
  >
    <i class={icon}></i>
    <span>
      {type}
      {update.status === "Downloading" && update.progress !== undefined
        ? `${Math.round(update.progress)}%`
        : update.status}
    </span>
  </button>
  {#if update.status === "Error" && isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="fixed bg-neutral-900/95 backdrop-blur text-red-400 p-3 rounded-xl shadow-xl border border-neutral-700 w-96 max-h-64 overflow-y-auto font-mono text-xs text-left z-50 overflow-x-hidden whitespace-pre-wrap break-words cursor-text"
      style={popupStyle}
      onclick={(e) => e.stopPropagation()}
    >
      {update.message || "Unknown error"}
    </div>
  {/if}
{/if}
