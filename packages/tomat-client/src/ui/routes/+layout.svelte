<script lang="ts">
  import "virtual:uno.css"
  import "@unocss/reset/tailwind-v4.css"
  import "../app.css"
  import { onMount } from "svelte"
  import { installTauriPlatform } from "$lib/platform/tauri"
  import { connectionState } from "$lib/state/connection.svelte"

  onMount(() => {
    installTauriPlatform()
    // Connection-state subscription is persistent (cores() re-binds it on
    // every select()), so it is safe to attach before any core is paired.
    // The core restore + initial-mode decision happens in +page.svelte so it
    // completes before the page's first render.
    connectionState.attach()
  })
</script>

{#if connectionState.showReconnectBanner}
  <div class="reconnect-banner" role="status" aria-live="polite">
    {connectionState.reason
      ? `Can't reach core: ${connectionState.reason}`
      : "Reconnecting to core…"}
  </div>
{/if}
<slot />

<style>
  .reconnect-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    padding: 0.5rem 1rem;
    text-align: center;
    font-size: 0.85rem;
    background: var(--accent-yellow-200, #fef9c3);
    color: var(--accent-yellow-900, #422006);
    border-bottom: 1px solid var(--accent-yellow-400, #facc15);
  }
  :global(.dark) .reconnect-banner {
    background: var(--accent-yellow-d-200, #422006);
    color: var(--accent-yellow-d-900, #fef9c3);
    border-bottom-color: var(--accent-yellow-d-400, #facc15);
  }
</style>
