<script lang="ts">
  import "virtual:uno.css";
  import "@unocss/reset/tailwind-v4.css";
  import "@tomat/shared/ui/styles/base.css";
  import "../app.css";
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import { installPlatform, isAndroidPlatform, isMobilePlatform } from "$lib/platform/select";
  import { connectionState } from "$stores/connection.svelte";
  import { coreStatusState } from "$stores/core-status.svelte";
  import { makeUiContext, setUiContext } from "@tomat/shared/ui/context";
  import { getDefaultSettings } from "@tomat/shared";
  import { settingsState } from "$stores";
  import { expansionState, isExpanded } from "$stores/expansion.svelte";
  import { backState } from "$stores/back.svelte";
  import { getDuration } from "$lib/appearance/animations";

  // Same schema defaults the website's DEFAULT_UI_CONTEXT uses, so a missing
  // live setting falls back to exactly what a fresh app would render.
  const settingDefaults = getDefaultSettings();

  // Back the shared UI context (read by the extracted @tomat/shared/ui
  // components: Bubble, Tabs, ...) with the client's live stores. The factory
  // owns the settings-derived members (alignment, blur, the system-message
  // tint), so the client cannot drift from the website's DEFAULT_UI_CONTEXT.
  // `getSetting` reads the live store, keeping the reactive link so a settings
  // change repaints bubbles/knobs exactly as before extraction.
  // Form factor drives the shared Views' layout/touch branches. Resolved from
  // the running OS in the browser only; prerender stays desktop-shaped (no Tauri
  // runtime), and the browser script init re-runs and sets the real values.
  const onMobile = browser && isMobilePlatform();

  setUiContext(
    makeUiContext({
      getSetting: (key) => settingsState.currentSettings[key] ?? settingDefaults[key],
      animationDurationMs: (ms) => getDuration(ms),
      expansionGet: (id, fallback) => isExpanded(id, fallback),
      expansionSet: (id, value) => expansionState.set(id, value),
      expansionInit: (id, value) => {
        if (!expansionState.has(id)) expansionState.set(id, value);
      },
      platform: onMobile ? "mobile" : "desktop",
      pointer: onMobile ? "coarse" : "fine",
      // Android owns the system back gesture, so its shells drop the in-app
      // back / close buttons; iOS and desktop keep them.
      hasSystemBack: onMobile && isAndroidPlatform(),
      registerBack: (handler) => backState.push(handler),
    }),
  );

  // Install the platform singleton during the layout's script init, NOT in
  // onMount: in SvelteKit the child +page.svelte's onMount fires before the
  // parent layout's, and +page.svelte's onMount calls platform() (via
  // loadClientSettings -> applyToggleWindowShortcut). The parent script runs
  // before any child onMount, so this guarantees setPlatform() lands first.
  // Guarded by `browser` to stay out of SSR/prerender (the impl imports
  // @tauri-apps/*).
  if (browser) installPlatform();

  onMount(() => {
    // Connection-state subscription is persistent (cores() re-binds it on
    // every select()), so it is safe to attach before any core is paired.
    // The core restore + initial-mode decision happens in +page.svelte so it
    // completes before the page's first render.
    connectionState.attach();
    // Backend core status (core.status frames) feeds the CoreBar alongside the
    // transport state above; same persistent-subscription rationale.
    coreStatusState.attach();
    // The mobile soft-keyboard / safe-area insets are injected natively as CSS
    // variables (see the Android MainActivity); the shell consumes them directly,
    // so there is nothing to wire up here.
  });
</script>

<slot />
