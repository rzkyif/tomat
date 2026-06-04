<script lang="ts">
  import "virtual:uno.css"
  import "@unocss/reset/tailwind-v4.css"
  import "../app.css"
  import { onMount } from "svelte"
  import { browser } from "$app/environment"
  import { installTauriPlatform } from "$lib/platform/tauri"
  import { connectionState } from "$lib/state/connection.svelte"

  // Install the platform singleton during the layout's script init, NOT in
  // onMount: in SvelteKit the child +page.svelte's onMount fires before the
  // parent layout's, and +page.svelte's onMount calls platform() (via
  // loadClientSettings -> applyToggleWindowShortcut). The parent script runs
  // before any child onMount, so this guarantees setPlatform() lands first.
  // Guarded by `browser` to stay out of SSR/prerender (the impl imports
  // @tauri-apps/*).
  if (browser) installTauriPlatform()

  onMount(() => {
    // Connection-state subscription is persistent (cores() re-binds it on
    // every select()), so it is safe to attach before any core is paired.
    // The core restore + initial-mode decision happens in +page.svelte so it
    // completes before the page's first render.
    connectionState.attach()
  })
</script>

<slot />
