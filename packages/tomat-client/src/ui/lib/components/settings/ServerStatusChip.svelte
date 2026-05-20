<script lang="ts">
  import type { ServerStatus, ServerStatusUpdate } from "$lib/shared/types";

  let { type, update } = $props<{
    type: "LLM" | "STT" | "Bun";
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
    Disabled: "bg-default-200 text-default-600",
    Error: "bg-accent-red-200 text-accent-red-700",
    Loading: "bg-accent-orange-200 text-accent-orange-700",
    Running: "bg-accent-green-200 text-accent-green-700",
  };
  const color = $derived(colorMap[update.status as ServerStatus]);

  const iconMap: Record<ServerStatus, string> = {
    Disabled: "i-material-symbols-nearby-off-rounded",
    Error: "i-material-symbols-warning-rounded",
    Loading: "i-line-md:loading-loop",
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
    class="flex items-center gap-1.5 px-3 py-1 rounded-large {color} {update.status ===
    'Error'
      ? 'cursor-pointer'
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
      {update.status}
    </span>
  </button>
  {#if update.status === "Error" && isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="fixed bg-default-900 backdrop-blur text-accent-red-400 p-3 rounded-large shadow-xl border border-default-700 w-96 max-h-64 overflow-y-auto font-mono text-xs text-left z-50 overflow-x-hidden whitespace-pre-wrap break-words cursor-text"
      style={popupStyle}
      onclick={(e) => e.stopPropagation()}
    >
      {update.message || "Unknown error"}
    </div>
  {/if}
{/if}
