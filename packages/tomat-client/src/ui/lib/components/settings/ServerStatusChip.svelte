<script lang="ts">
  import type { ServerStatus, ServerStatusUpdate } from "$lib/shared/types";
  import Chip from "../ui/Chip.svelte";

  let { type, update } = $props<{
    type: "LLM" | "STT" | "TTS";
    update: ServerStatusUpdate;
  }>();

  let isOpen = $state(false);
  let buttonEl = $state<HTMLDivElement>();
  let popupStyle = $state("");

  function updatePopupPosition() {
    if (!buttonEl) return;
    const rect = buttonEl.getBoundingClientRect();
    popupStyle =
      `left: ${rect.left}px; bottom: ${window.innerHeight - rect.top + 8}px;`;
  }

  type Variant = "default" | "accent";
  type Accent = "blue" | "purple" | "red" | "green" | "yellow";

  const styleByStatus: Record<
    ServerStatus,
    { variant: Variant; accent?: Accent; icon: string }
  > = {
    Disabled: {
      variant: "default",
      icon: "i-material-symbols-nearby-off-rounded",
    },
    Error: {
      variant: "accent",
      accent: "red",
      icon: "i-material-symbols-warning-rounded",
    },
    Loading: {
      variant: "accent",
      accent: "yellow",
      icon: "i-line-md:loading-loop",
    },
    Running: {
      variant: "accent",
      accent: "green",
      icon: "i-material-symbols-check-rounded",
    },
  };
  const style = $derived(styleByStatus[update.status as ServerStatus]);

  function toggle() {
    if (update.status === "Error") {
      isOpen = !isOpen;
      if (isOpen) updatePopupPosition();
    }
  }
</script>

{#if update.status !== "Running" && update.status !== "Disabled"}
  <div bind:this={buttonEl}>
    <Chip
      class="w-full"
      icon={style.icon}
      label="{type} {update.status}"
      variant={style.variant}
      accent={style.accent}
      title={update.status !== "Error" ? update.message || update.status : undefined}
      onclick={update.status === "Error"
        ? (e) => {
            toggle();
            e.stopPropagation();
          }
        : undefined}
    />
  </div>
  {#if update.status === "Error" && isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="tomat-scroll-inset fixed bg-accent-red-100 text-accent-red-900 border border-accent-red-300 p-3 rounded-large shadow-xl w-96 max-h-64 overflow-y-auto font-mono text-xs text-left z-50 overflow-x-hidden whitespace-pre-wrap break-words cursor-text"
      style={popupStyle}
      onclick={(e) => e.stopPropagation()}
    >
      {update.message || "Unknown error"}
    </div>
  {/if}
{/if}
