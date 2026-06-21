<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import AgentMessage from "$components/chat/messages/AgentMessage.svelte";
  import ErrorMessage from "$components/chat/messages/ErrorMessage.svelte";
  import AutomatedPrompt from "$components/chat/messages/AutomatedPrompt.svelte";
  import SystemMessage from "$components/chat/messages/SystemMessage.svelte";
  import DisplayBubble from "$components/chat/messages/DisplayBubble.svelte";
  import ToolCall from "$components/chat/messages/ToolCall.svelte";
  import RelevantTools from "$components/chat/messages/RelevantTools.svelte";
  import RelevantMemories from "$components/chat/messages/RelevantMemories.svelte";
  import UserInput from "$components/chat/UserInput.svelte";
  import UserMessage from "$components/chat/messages/UserMessage.svelte";
  import SessionBar from "$components/chat/SessionBar.svelte";
  import Settings from "$components/settings/Settings.svelte";
  import NewCore from "$components/new-core/NewCore.svelte";
  import QuickSettings from "$components/quick-settings/QuickSettings.svelte";
  import SessionList from "$components/session-list/SessionList.svelte";
  import Bubble from "@tomat/shared/ui/components/primitives/Bubble.svelte";
  import { bubbleGap, useUiContext } from "@tomat/shared/ui/context";
  import MessageStackGroup from "$components/chat/MessageStackGroup.svelte";
  import {
    asMessageContent,
    displayContentOf,
    getTextContent,
    type Message,
    type MessageContent,
  } from "$lib/util/types";
  import {
    downloadsState,
    memoriesState,
    messagesState,
    scheduledPromptsState,
    serversState,
    sessionsState,
    settingsState,
    snippetsState,
    streamingState,
    toolkitsState,
    updateState,
    viewState,
  } from "$stores";
  import { connectionState } from "$stores/connection.svelte";
  import { cores } from "$lib/core";
  import { platform } from "$lib/platform";
  import { useTheme } from "$composables/use-theme.svelte";
  import { getLogger } from "$lib/util/log";
  import {
    shortcutHandler,
    windowTransition,
  } from "$stores/shortcut.svelte";
  import {
    BASE_MS,
    enableMessageAnimations,
    getDuration,
    hasMessageAnimated,
  } from "$lib/appearance/animations";
  import MessageEnter from "$components/chat/MessageEnter.svelte";

  // Sidecar lifecycle is server-side; the client only attaches WS-driven
  // state subscribers so status frames reach the UI.
  function setupSidecarListeners(): void {
    /* no-op: handled by serversState.attach() in onMount */
  }
  async function startConfiguredServices(): Promise<void> {
    /* no-op: handled server-side */
  }
  import {
    startClickThrough,
    stopClickThrough,
    pauseClickThrough,
    resumeClickThrough,
  } from "$lib/window/window";
  import {
    startBlurKeepalive,
    stopBlurKeepalive,
  } from "$lib/window/window";

  const log = getLogger("boot");
  const windowLog = getLogger("window");
  const ui = useUiContext();

  // The keepalive runs exactly while halo rings exist (same condition as
  // Bubble.svelte's ringCount); without rings there's no backdrop to keep
  // fresh.
  const blurActive = $derived(
    settingsState.currentSettings["appearance.bubbleBlurEnabled"] !== false &&
      ((settingsState.currentSettings["appearance.bubbleBlurRings"] as number) ?? 3) > 0,
  );
  $effect(() => {
    if (blurActive) startBlurKeepalive();
    else stopBlurKeepalive();
  });

  // Appearance/layout settings applied to documentElement live in the theme
  // composable; the consumer owns the boot apply + the per-key $effects below.
  // SSR is off (see +layout.ts) so it's safe to touch `window`/`document`.
  const theme = useTheme();

  let loaded = $state(false);
  let sessionLoading = $state(true);
  let container: HTMLElement | undefined = $state();
  let contentEl: HTMLElement | undefined = $state();

  // Panel slide animates a viewport-sized wrapper around `main` rather than
  // the inner panel itself. The wrapper is `w-screen h-screen`, so a 100%
  // translate moves it by a full viewport (clearing main's p-10 padding
  // that previously left the bubble's first 40px visible at the edge).
  // The wrapper persists across the chat/settings swap, so the imperative
  // sequence is just: slide out, swap content inside, slide back in.
  let panelLayer: HTMLElement | undefined = $state();
  let panelToggling = false;

  const animationsEnabled = $derived(
    !!settingsState.currentSettings["appearance.animationsEnabled"],
  );

  function offscreenTransform(alignment: "left" | "center" | "right"): string {
    if (alignment === "left") return "translateX(-100%)";
    if (alignment === "right") return "translateX(100%)";
    return "translateY(100%)";
  }

  const TRANSITION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

  // First launch parks the content offscreen, reveals the (transparent)
  // window, then waits this long before sliding the content in, giving the
  // freshly mounted UI a beat to settle so the slide starts from a stable
  // layout instead of shifting mid-animation.
  const BOOT_SHOW_DELAY_MS = 1000;

  // Imperatively drive the window-level slide on `container`. Mirrors the
  // same JS+CSS pattern used for panel swap (`runSlide`): set transition then
  // target style; the WKWebView transition fires reliably because the source
  // value is already on the element.
  //   - "visible":   on screen (transform cleared) and opaque.
  //   - "offscreen": slid out per alignment and held opaque, so the slide
  //                  reads as pure motion with no fade in either direction.
  // First paint inlines opacity:0 directly on the element so the window
  // doesn't flash visible before the first applyWindowState() runs; the first
  // "offscreen" call lifts it to 1 while the content is safely off-screen.
  function applyWindowState(state: "visible" | "offscreen", animate: boolean) {
    if (!container) return;
    const dur = animate ? getDuration() : 0;
    container.style.transition =
      dur > 0
        ? `transform ${dur}ms ${TRANSITION_EASING}, opacity ${dur}ms ${TRANSITION_EASING}`
        : "";
    if (state === "visible") {
      container.style.transform = "";
      container.style.opacity = "1";
    } else {
      // Hold opacity at 1 so the window slides without fading (a full-100%
      // translate already clears it from the viewport). Setting it explicitly
      // also lifts the first-paint opacity:0 so the initial boot slide-in is
      // pure motion rather than a fade.
      container.style.opacity = "1";
      container.style.transform = offscreenTransform(
        settingsState.getAlignment(),
      );
    }
  }

  let hidingInFlight = false;

  async function animateHideThenHide() {
    if (hidingInFlight) return;
    hidingInFlight = true;
    windowTransition.begin();
    applyWindowState("offscreen", true);
    try {
      await new Promise((r) => setTimeout(r, getDuration()));
      await platform().windowing.hide();
    } catch (e) {
      windowLog.warn("hide failed:", e);
    } finally {
      hidingInFlight = false;
      windowTransition.end();
    }
  }

  // Tail of the first-launch reveal: the onMount finally below has already
  // parked the content offscreen, opened the `windowTransition` guard, and
  // shown the window. After a settle beat, slide the content in with the same
  // animation as a shortcut-driven show, then close the guard once it lands.
  async function revealAfterSettle() {
    await new Promise((r) => setTimeout(r, BOOT_SHOW_DELAY_MS));
    applyWindowState("visible", true);
    await new Promise((r) => setTimeout(r, getDuration()));
    windowTransition.end();
  }

  const linkHandler = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor && anchor.href && anchor.href.startsWith("http")) {
      const url = new URL(anchor.href);
      if (
        !url.hostname.includes("localhost") &&
        !url.hostname.includes("tauri.localhost")
      ) {
        e.preventDefault();
        void platform().openExternal(anchor.href);
      }
    }
  };

  async function positionWindow() {
    try {
      await platform().windowing.position({
        monitorId: settingsState.getMonitor(),
        alignment: settingsState.getAlignment(),
        width: (settingsState.currentSettings["layout.width"] as number | undefined) ?? 700,
      });
    } catch (e) {
      windowLog.error("Failed to position window", e);
    }
  }

  let unlistenVisibility: (() => void) | null = null;
  let unlistenMonitor: (() => void) | null = null;
  let unlistenHideRequested: (() => void) | null = null;
  let cleanupSystemTheme: (() => void) | null = null;

  // Autostart (login) launches stay hidden until something reveals the window:
  // a greeting completing, the core reporting no greeting ran, or this
  // last-resort watchdog firing when the core never connects at all. Module
  // scope so onDestroy can clear it.
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  const AUTOSTART_REVEAL_FALLBACK_MS = 10_000;

  // On-demand mode: when the selected core points at loopback and the binary
  // is installed locally, spawn it ourselves if no service has it running.
  // Idempotent: start_local_core probes the port first and exits cleanly if
  // the core is already up. Failures are non-fatal: the user sees a normal
  // "could not reach core" error from the regular call paths.
  async function ensureLocalCoreUpIfNeeded(): Promise<void> {
    const current = cores().currentEntry();
    if (!current) return;
    if (
      !current.baseUrl.includes("127.0.0.1") &&
      !current.baseUrl.includes("localhost")
    ) {
      return;
    }
    try {
      if (await platform().pairing.isLocalCoreInstalled()) {
        await platform().pairing.startLocalCore();
      }
    } catch (e) {
      log.error("ensureLocalCoreUpIfNeeded:", e);
    }
  }

  // Redirect out of the two core-backed transient modes while reconnecting:
  // quick settings falls back to settings (which shows its own disabled state)
  // and the session list (which reads/loads sessions from the core) falls back
  // to chat, the safe resting mode.
  $effect(() => {
    if (!connectionState.reconnecting) return;
    if (viewState.mode === "quickSettings") viewState.navigate("settings");
    else if (viewState.mode === "sessionList") viewState.navigate("chat");
  });

  // The core rejected our bearer token (e.g. its DB was reset, so it no longer
  // knows this client). The stored token is permanently dead, so silently drop
  // the core and fall back to onboarding instead of stranding the user. Mirrors
  // the manual unpair flow in CoresField. currentEntry() guards re-entry: it's
  // null once removed, so the effect can't act twice.
  $effect(() => {
    if (!connectionState.unauthorized) return;
    const dead = cores().currentEntry();
    if (!dead) return;
    void (async () => {
      try {
        await cores().removePaired(dead.id);
        const remaining = await cores().list();
        if (remaining.length === 0) viewState.setLocked(true);
        else if (!cores().currentEntry()) await cores().select(remaining[0].id);
      } catch (e) {
        log.error("auto-unpair after auth rejection failed:", e);
      }
    })();
  });

  // Boot counterpart of the auth-rejection effect above. restoreSelected can
  // leave no core active when a paired entry's token is gone from the keychain
  // (e.g. after a dev reset): select() throws "no token" before any connection,
  // so connectionState never reaches "unauthorized" and the effect never fires.
  // Drop those tokenless cores and fall back to onboarding instead of hanging in
  // "Connecting to core...". A keychain *error* (get throws) is left alone so a
  // transient glitch can't unpair a still-valid core.
  async function dropTokenlessCoresAndMaybeOnboard(): Promise<void> {
    if (cores().currentEntry()) return; // a core selected fine; nothing to do
    for (const c of await cores().list()) {
      let token: string | null = null;
      try {
        token = await platform().keychain.get(c.id);
      } catch (e) {
        log.error(`keychain check failed for core "${c.name}"; leaving it paired:`, e);
        continue;
      }
      if (!token) {
        log.warn(`core "${c.name}" has no stored token; unpairing`);
        try {
          await cores().removePaired(c.id);
        } catch (e) {
          log.error("auto-unpair of tokenless core failed:", e);
        }
      }
    }
    const remaining = await cores().list();
    if (remaining.length === 0) viewState.setLocked(true);
    else if (!cores().currentEntry()) {
      try {
        await cores().select(remaining[0].id);
      } catch (e) {
        log.error("select after tokenless cleanup failed:", e);
      }
    }
  }

  onMount(async () => {
    // Local critical path: do ONLY the local work needed to position + theme
    // the window, then show it. Everything that touches the core / network /
    // keychain is deferred to after the window is visible (the deferred phase
    // below), so a slow or unreachable core can never keep the window hidden.
    // Whether this was a login/autostart launch decides whether we show the
    // window now or stay hidden until a greeting (or the watchdog) reveals it.
    // It is a local Tauri call (reads launch args); default to a manual launch.
    let autostarted = false;
    try {
      autostarted = await platform().autostart.wasAutostarted().catch(() => false);
      await settingsState.loadClientSettings();
      // Decide the initial mode from LOCAL data only: whether a core is paired
      // is the client-settings `cores` list, with no select()/keychain/network.
      const paired = (await cores().list()).length > 0;
      if (paired) {
        viewState.setImmediate("chat");
      } else {
        viewState.setImmediate("newCore");
        viewState.setLocked(true);
      }
      // Apply every appearance/layout DOM setting on the boot critical path so
      // the window paints correctly themed; the per-key $effects re-apply later.
      theme.applyAll(settingsState.currentSettings);
      // Only show the "Loading latest session…" placeholder when we're actually
      // about to load one: a core must be paired, and "always start new" mode
      // has nothing to load so the placeholder would mislead.
      sessionLoading = paired &&
        !settingsState.currentSettings["general.session.alwaysStartNew"];
      await positionWindow();
    } catch (e) {
      // A local read should never keep the window hidden. Log and show anyway.
      log.error("local critical path failed:", e);
    } finally {
      loaded = true;
      await tick();
      if (autostarted) {
        // Autostart (login) launch: park the content offscreen (no transition,
        // window still hidden) but do NOT show it, so the app starts quietly in
        // the background and a later reveal slides in cleanly. The reveal comes
        // from a greeting finishing (session.created show_when_done), the
        // deferred phase seeing the core report no greeting ran, or the
        // connectWatchdog firing when the core never connects, so an autostarted
        // app can never stay invisible.
        applyWindowState("offscreen", false);
        connectWatchdog = setTimeout(() => {
          void platform().windowing.show();
        }, AUTOSTART_REVEAL_FALLBACK_MS);
      } else if (getDuration() > 0) {
        // Park the content offscreen (no transition), reveal the window while
        // it is still clear of the viewport, then slide it in after a settle
        // beat. `windowTransition` spans the whole reveal so an early shortcut
        // press can't fight the slide. show() stays awaited so its
        // `window-visibility: true` event fires before the listener below
        // registers; otherwise that listener would slide the content in early.
        windowTransition.begin();
        applyWindowState("offscreen", false);
        await platform().windowing.show();
        void revealAfterSettle();
      } else {
        // Animations off: show immediately with no slide.
        await platform().windowing.show();
        applyWindowState("visible", false);
      }
    }

    // Post-paint work. Fire-and-forget; the window is already visible.
    document.addEventListener("click", linkHandler);

    cleanupSystemTheme = theme.listenSystemTheme(() => {
      if (settingsState.currentSettings["appearance.theme"] === "auto") {
        theme.applyTheme("auto");
      }
    });

    if (contentEl) {
      void startClickThrough(contentEl);
    }

    platform()
      .windowing.subscribeVisibility((visible) => {
        if (visible) {
          applyWindowState("visible", true);
          resumeClickThrough();
          // Mirror the slide-in animation duration so spammed shortcut
          // presses can't reverse the in-progress show into a hide and
          // flicker.
          windowTransition.begin();
          setTimeout(() => windowTransition.end(), getDuration());
        } else {
          pauseClickThrough();
        }
      })
      .then((unlisten) => {
        unlistenVisibility = unlisten;
      });

    platform()
      .windowing.subscribeHideRequested(() => {
        void animateHideThenHide();
      })
      .then((unlisten) => {
        unlistenHideRequested = unlisten;
      });

    platform()
      .windowing.subscribeMonitorChanged(() => {
        if (loaded) positionWindow();
      })
      .then((unlisten) => {
        unlistenMonitor = unlisten;
      });

    // Global-shortcut listener lives here (not in UserInput) so it stays
    // attached when the user is in the Settings view; otherwise the
    // shortcut silently stops working whenever UserInput is unmounted.
    void shortcutHandler.attach();

    // Probe disk for every HF file the current configuration references,
    // then decide whether to start sidecars / TTS or wait. Nothing
    // downloads until the user explicitly confirms via the Settings
    // ConfirmModal: if anything is missing we stash the pending list
    // and leave sidecar startup to the modal's onConfirm handler. If
    // everything is already on disk we kick sidecars off immediately
    // (their `ensure()` calls hit the file-exists fast path with no
    // network I/O).
    setupSidecarListeners();
    // Deferred core phase: the window is already visible. Connect to the core,
    // merge its (non-visual) settings, and wire the WS-driven stores. Each
    // essential step logs on failure so a developer sees it in the dev console;
    // the window is up regardless.
    void (async () => {
      log.info("deferred boot: connecting to core");
      try {
        await cores().restoreSelected();
      } catch (e) {
        log.error("core restore failed:", e);
      }
      // If nothing got selected because a paired core's token is gone, unpair it
      // and return to onboarding rather than hanging in "Connecting to core...".
      await dropTokenlessCoresAndMaybeOnboard();
      // Reload the active core's sessions on every later core switch. Registered
      // after restoreSelected so boot's own select() doesn't double-trigger it.
      cores().subscribe(() => void sessionsState.loadLatest());
      // On-demand install: spawn the loopback core if it isn't up yet.
      await ensureLocalCoreUpIfNeeded();
      // Wire every WS-driven store to the core socket. These register listeners
      // synchronously and persist across core switches (cores().subscribeWs
      // re-binds on select()), so one attach is enough even before a core is
      // selected. This also kicks off the WS connect, whose failures now surface
      // in the reconnect banner. settingsState.attach() owns the core settings
      // baseline + live sync from here on: it loads on selection changes and
      // connected edges, and side effects (TTS arming etc.) fire through
      // settings-effects on every merged transition, so boot needs no explicit
      // core-settings fetch or per-module kick.
      settingsState.attach();
      toolkitsState.ensureConnected();
      memoriesState.attach();
      scheduledPromptsState.attach();
      streamingState.attach();
      serversState.attach();
      sessionsState.attach();
      downloadsState.attach();
      updateState.attach();
      // Report this app start to the greeting trigger once a core is
      // reachable (once per app run); core decides from the greetings.*
      // settings whether to open an automated greeting session.
      let greetingReported = false;
      let unsubGreeting: (() => void) | null = null;
      unsubGreeting = cores().subscribeConnectionState((state) => {
        if (state !== "connected" || greetingReported) return;
        greetingReported = true;
        // One-shot: later connected edges must not re-trigger, so drop the
        // subscription instead of leaking it for the app's lifetime. (Null
        // only if this fires synchronously during subscribe; the flag above
        // already guards re-entry then.)
        unsubGreeting?.();
        // Connected: the no-connection watchdog is moot now.
        if (connectWatchdog !== null) {
          clearTimeout(connectWatchdog);
          connectWatchdog = null;
        }
        void (async () => {
          // The route answers immediately (the greeting itself starts in the
          // background once the model is loaded), so a slow response means
          // something is wrong; don't let an autostart window stay hidden
          // behind a hung request.
          const res = await Promise.race([
            cores()
              .api()
              .greetings.run(autostarted ? "autostart" : "manual"),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("greeting trigger timed out")), 10_000),
            ),
          ]);
          // Safety net for an autostart launch that stayed hidden: if the core
          // ran no greeting (greetings off, or runOn gated this launch out),
          // reveal the window now. When a greeting DID run, its session reveals
          // the window on completion via the show_when_done focus path.
          if (autostarted && !res.ran) await platform().windowing.show();
        })().catch((e) => {
          log.warn("greeting trigger failed:", e);
          // On failure during an autostart launch, reveal rather than strand.
          if (autostarted) void platform().windowing.show();
        });
      });
      // Pull the required-files snapshot now that a core may be selected, and
      // re-pull on later core switches (downloadsState also keeps it live via
      // the requirements.snapshot WS frame).
      void downloadsState.refetchRequirements();
      cores().subscribe(() => void downloadsState.refetchRequirements());
      void snippetsState.load();
      // Initial session load, with the "Loading latest session…" placeholder.
      try {
        if (cores().currentEntry()) {
          if (settingsState.currentSettings["general.session.alwaysStartNew"]) {
            await sessionsState.loadList();
          } else {
            await sessionsState.loadLatest();
          }
        }
      } catch (e) {
        log.error("session load failed:", e);
      } finally {
        sessionLoading = false;
        // Enable per-message entry animations only AFTER the bulk restore
        // completes; otherwise 50 messages all animate in at once.
        await tick();
        enableMessageAnimations();
      }
    })();
  });

  onDestroy(() => {
    document.removeEventListener("click", linkHandler);
    stopClickThrough();
    stopBlurKeepalive();
    shortcutHandler.detach();
    unlistenVisibility?.();
    unlistenMonitor?.();
    unlistenHideRequested?.();
    cleanupSystemTheme?.();
    if (connectWatchdog !== null) clearTimeout(connectWatchdog);
  });

  // Drive the panel slide whenever a navigation is requested. viewState holds
  // `pendingMode` (requested) and `mode` (committed/rendered); this effect runs
  // the 3-phase slide (out → commit (offscreen) → in) toward pendingMode.
  $effect(() => {
    const target = viewState.pendingMode;
    if (target === viewState.mode) return; // settled, nothing to slide
    if (panelToggling) return; // a slide is already mid-flight
    void runSlide();
  });

  async function runSlide() {
    if (panelToggling) return;
    panelToggling = true;

    const dur = getDuration();
    const layer = panelLayer;

    if (layer && dur > 0) {
      const offscreen = offscreenTransform(settingsState.getAlignment());

      // Phase 1: slide the wrapper (and everything inside) offscreen.
      layer.style.transition = `transform ${dur}ms ${TRANSITION_EASING}`;
      layer.style.transform = offscreen;
      await new Promise((r) => setTimeout(r, dur));

      // Phase 2: commit the mode swap while offscreen, so the new mode
      // mounts already offscreen with no extra positioning.
      viewState.commit();
      await tick();

      // Phase 3: slide the wrapper back to its natural position.
      layer.style.transform = "";
      await new Promise((r) => setTimeout(r, dur));
      layer.style.transition = "";
    } else {
      viewState.commit();
    }

    panelToggling = false;
    if (viewState.mode === "chat") scrollToBottom();
    // pendingMode may have changed again mid-slide (rapid navigation): re-run.
    if (viewState.pendingMode !== viewState.mode) void runSlide();
  }

  $effect(() => {
    const _align = settingsState.getAlignment();
    const _mon = settingsState.getMonitor();
    const _width = settingsState.currentSettings["layout.width"];

    if (loaded) {
      positionWindow();
    }
  });

  $effect(() => {
    const mode = settingsState.currentSettings["appearance.theme"];
    if (loaded && mode) theme.applyTheme(mode);
  });

  $effect(() => {
    const size = settingsState.currentSettings["appearance.textSize"];
    if (loaded && size) theme.applyTextSize(size as number);
  });

  $effect(() => {
    const v = settingsState.currentSettings["appearance.userBubbleColor"];
    if (loaded) theme.setThemeColor("--user-bubble-bg-light", "--user-bubble-bg-dark", v);
  });

  $effect(() => {
    const v = settingsState.currentSettings["appearance.agentBubbleColor"];
    if (loaded) theme.setThemeColor("--agent-bubble-bg-light", "--agent-bubble-bg-dark", v);
  });

  $effect(() => {
    const v =
      settingsState.currentSettings["appearance.secondaryAgentBubbleColor"];
    if (loaded) theme.setThemeColor("--agent2-bubble-bg-light", "--agent2-bubble-bg-dark", v);
  });

  $effect(() => {
    const v = settingsState.currentSettings["appearance.defaultColor"];
    if (loaded) theme.applyBubbleColor("--default-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentRed"];
    if (loaded) theme.applyBubbleColor("--accent-red-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentBlue"];
    if (loaded) theme.applyBubbleColor("--accent-blue-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentPurple"];
    if (loaded) theme.applyBubbleColor("--accent-purple-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentGreen"];
    if (loaded) theme.applyBubbleColor("--accent-green-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentYellow"];
    if (loaded) theme.applyBubbleColor("--accent-yellow-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.roundedSmall"];
    if (loaded) theme.applyCssVarPx("--rounded-small", v as number);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.roundedMedium"];
    if (loaded) theme.applyCssVarPx("--rounded-medium", v as number);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.roundedLarge"];
    if (loaded) theme.applyCssVarPx("--rounded-large", v as number);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.defaultFont"];
    if (loaded) theme.applyFont("--font-default", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.monoFont"];
    if (loaded) theme.applyFont("--font-mono", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.bubbleShadowColor"];
    if (loaded) {
      theme.setThemeColor("--bubble-shadow-color-light", "--bubble-shadow-color-dark", v);
    }
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.bubbleShadowDistance"];
    if (loaded) theme.applyCssVarPx("--bubble-shadow-distance", v as number);
  });
  // bubbleBlurEnabled / bubbleBlurRings drive the halo layer count directly in
  // Bubble.svelte (reactive read of settingsState), so no DOM apply here.

  async function scrollToBottom() {
    await tick();
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
    }
  }

  // Find the most recent user message (messages is newest-first).
  // Used to default the editing target to the latest sent message.
  let lastUserMsg = $derived(
    messagesState.messages.find((m) => m.role === "user"),
  );
  let lastUserMsgId = $derived(lastUserMsg?.id ?? null);

  // Single shared "which user message is in edit mode": only one bubble can
  // edit at a time. Defaults to (and resets to) the latest user message
  // whenever a new turn arrives or the latest is deleted; double-clicking a
  // different user bubble switches the target without losing pending debounced
  // edits (UserMessage flushes on its own when editing flips off).
  let editingUserMsgId = $state<string | null>(null);
  $effect(() => {
    editingUserMsgId = lastUserMsgId;
  });

  // Visible while the assistant turn is in flight but we haven't received
  // anything yet, neither reasoning nor content. Drives a transient
  // small-bubble spinner so the user has a visual cue between sending and
  // first-token arrival. As soon as either reasoning or content fires, this
  // turns false and the corresponding real bubble takes over.
  let showStreamingLoadingBubble = $derived(
    streamingState.isActive && streamingState.awaitingFirstDelta,
  );

  // A "small bubble" message is one rendered as a `size="small"` Bubble
  // (system prompt, reasoning, tool_filter, tool, plus the synthetic loading
  // sentinel). Consecutive small bubbles are grouped into a MessageStackGroup,
  // which renders one or more horizontally-scrollable substacks of collapsed
  // bubbles separated by standalone rows for any bubbles whose Expandable is
  // open. Expanding a bubble in a substack splits that substack around the
  // bubble; collapsing merges the surrounding substacks back together.
  // `messagesSeen` in animations.ts dedupes the slide-in transition so
  // re-mounts caused by segment regrouping don't replay it.
  function isSmallBubbleMsg(msg: Message): boolean {
    if (msg.role === "system") return true;
    if (msg.role === "reasoning") return true;
    if (msg.role === "loading") return true;
    if (msg.role === "tool") return true;
    if (msg.role === "tool_filter") return true;
    if (msg.role === "memory_filter") return true;
    if (msg.role === "display") return true;
    // Core-authored prompt of an automated session: a collapsed
    // "Automated Prompt" bubble instead of a full user bubble.
    if (msg.role === "user" && msg.automated) return true;
    return false;
  }

  type RenderGroup =
    | { kind: "stack"; key: string; messages: Message[] }
    | { kind: "single"; key: string; message: Message };

  // Stable id for the synthetic loading sentinel, consistent across the
  // bubble's mounted lifetime so keyed each blocks don't churn while it's
  // visible. The dedup-by-msgId guard inside `messageEnter` is bypassed
  // separately for this id so each appearance still animates in/out.
  const LOADING_MSG_ID = "__streaming_loading__";

  // Filter out hidden messages (empty assistant placeholders mid-stream and
  // reasoning when the setting is off) before grouping so the chain logic
  // sees only what'll actually render. Then inject a synthetic small-bubble
  // loading sentinel at the newest position OF THE RUNNING TURN when we're
  // awaiting the first response chunk. That lets it stack with adjacent
  // small bubbles (tool_filter, reasoning, system) via the existing
  // grouping pipeline instead of being a standalone element outside it.
  let displayedMessages = $derived.by<Message[]>(() => {
    const real = messagesState.messages.filter((msg) => {
      const isEmptyAssistant =
        msg.role === "assistant" && getTextContent(msg.content) === "";
      const isHiddenReasoning =
        msg.role === "reasoning" &&
        !settingsState.currentSettings["llm.showReasoning"];
      const isHiddenSystem =
        msg.role === "system" &&
        !settingsState.currentSettings["prompts.showSystemPrompt"];
      // Empty filter bubbles (no relevant tools / memories found) are hidden
      // unless the user opts to keep them. Errors always show. "No relevant
      // tools" is the filter result, not toolsSent: always-available tools
      // would otherwise keep the bubble on every turn.
      const toolFilterBase =
        msg.phase2 !== undefined
          ? msg.phase2.length
          : (msg.phase1?.length ?? 0);
      const isHiddenEmptyToolFilter =
        msg.role === "tool_filter" &&
        msg.status !== "error" &&
        toolFilterBase === 0 &&
        !settingsState.currentSettings["tools.showEmptySelection"];
      const isHiddenEmptyMemoryFilter =
        msg.role === "memory_filter" &&
        msg.status !== "error" &&
        (msg.relevant?.length ?? 0) === 0 &&
        !settingsState.currentSettings["memories.showEmptySelection"];
      return (
        !isEmptyAssistant &&
        !isHiddenReasoning &&
        !isHiddenSystem &&
        !isHiddenEmptyToolFilter &&
        !isHiddenEmptyMemoryFilter
      );
    });
    if (!showStreamingLoadingBubble) return real;
    const loadingMsg: Message = {
      id: LOADING_MSG_ID,
      role: "loading",
      content: "",
    };
    // Mid-history regenerate: the streaming layer is inserting bubbles
    // between the anchor user message and the next-newer user message, so
    // the sentinel must land in that same slot - just newer than the
    // next-newer user message (or at index 0 if none) - to appear at the
    // top of the running turn instead of at the very top of the array.
    const anchorId = streamingState.turnAnchorId;
    if (anchorId === null) return [loadingMsg, ...real];
    const anchorIdx = real.findIndex((m) => m.role === "user" && m.id === anchorId);
    if (anchorIdx < 0) return [loadingMsg, ...real];
    let insertIdx = 0;
    for (let i = anchorIdx - 1; i >= 0; i--) {
      if (real[i].role === "user") {
        insertIdx = i + 1;
        break;
      }
    }
    return [...real.slice(0, insertIdx), loadingMsg, ...real.slice(insertIdx)];
  });

  function msgKey(msg: Message, fallback: string): string {
    return msg.id ?? msg.callId ?? fallback;
  }

  // Assistant bubble text, with the interrupted note appended at render
  // time: the persisted content stays the clean partial text, the note is
  // presentation only.
  function assistantContent(msg: Message): MessageContent {
    const base = asMessageContent(msg.content);
    if (msg.truncated) {
      const text = getTextContent(base);
      const note = "> _Reply cut off: the context window is full._";
      return text ? `${text}\n\n${note}` : note;
    }
    if (!msg.interrupted) return base;
    const text = getTextContent(base);
    return text ? `${text}\n\n> _Interrupted._` : "> _Interrupted._";
  }

  let messageGroups = $derived.by<RenderGroup[]>(() => {
    const groups: RenderGroup[] = [];
    let stack: Message[] = [];
    // messages is newest-first, but the user wants stacked small
    // bubbles in old→new visual order (oldest at the screen-facing edge,
    // wrapping rightward and downward). We collect into `stack` in the
    // newest-first iteration order, then reverse on flush so DOM[0] of the
    // stack is the OLDEST message, placing it leftmost (left/center
    // alignment with flex-row) or rightmost (right alignment with
    // flex-row-reverse).
    const flushStack = () => {
      if (stack.length === 0) return;
      stack.reverse();
      const head = stack[0];
      groups.push({
        kind: "stack",
        key: `stack:${msgKey(head, `s-${groups.length}`)}`,
        messages: stack,
      });
      stack = [];
    };
    for (let i = 0; i < displayedMessages.length; i++) {
      const msg = displayedMessages[i];
      if (isSmallBubbleMsg(msg)) {
        stack.push(msg);
      } else {
        flushStack();
        groups.push({
          kind: "single",
          key: `single:${msgKey(msg, `i-${i}`)}`,
          message: msg,
        });
      }
    }
    flushStack();
    return groups;
  });

  // Entry-animation stagger, in vertical order: bubbles that mount in the
  // same flush (e.g. the system prompt + the first user message + the
  // loading sentinel) slide in top-to-bottom, each waiting one BASE_MS slot
  // per not-yet-animated bubble above it. Bubbles that already animated
  // (hasMessageAnimated) are settled and don't occupy a slot; their own
  // delay value is moot because claimMessageEnter dedupes by msgId.
  function enterDelayKey(msg: Message): string | null {
    if (msg.role === "loading") return LOADING_MSG_ID;
    return msg.id ?? msg.callId ?? null;
  }
  // Bulk mounts (switching to a session whose bubbles haven't animated this
  // run) keep the everything-at-once entrance; the stagger is only for the
  // small batches a single turn produces.
  const MAX_STAGGER_COHORT = 4;
  let enterDelays = $derived.by<Map<string, number>>(() => {
    // displayedMessages is newest-first; collect oldest-first (top of screen
    // first) so delays grow downward.
    const entering: string[] = [];
    for (let i = displayedMessages.length - 1; i >= 0; i--) {
      const msg = displayedMessages[i];
      const key = enterDelayKey(msg);
      if (!key) continue;
      // The loading sentinel re-animates on every appearance (its msgId is
      // withheld from the dedupe), so it always counts as entering.
      if (msg.role !== "loading" && hasMessageAnimated(key)) continue;
      entering.push(key);
    }
    const delays = new Map<string, number>();
    if (entering.length > MAX_STAGGER_COHORT) return delays;
    const slot = getDuration(BASE_MS);
    entering.forEach((key, i) => delays.set(key, i * slot));
    return delays;
  });
</script>

{#if loaded}
  <div
    bind:this={panelLayer}
    class="w-screen h-screen overflow-hidden"
    class:will-change-transform={animationsEnabled}
  >
    <main
      bind:this={container}
      class="no-scrollbar flex flex-col-reverse justify-start p-10 text-default-800 w-fit max-w-screen min-h-screen max-h-screen overflow-x-clip overflow-y-auto"
      class:mx-auto={settingsState.getAlignment() === "center"}
      class:ml-auto={settingsState.getAlignment() === "right"}
      class:mr-auto={settingsState.getAlignment() === "left"}
      class:will-change-transform={animationsEnabled}
      style="opacity: 0"
    >
    <div bind:this={contentEl} class="flex flex-col-reverse gap-2 my-auto">
      {#if viewState.mode === "chat"}
        <!-- reading-flow: flex-visual makes keyboard focus traverse the column
             in VISUAL order (top oldest -> bottom newest -> input -> session
             bar) instead of DOM order. The DOM is newest-first so flex-col-
             reverse can put the newest row at the bottom and keep the scroll
             anchored there for free autoscroll; without reading-flow that makes
             Tab walk bottom-to-top. Honored by Chromium webviews (WebView2);
             where unsupported it's ignored and order falls back to DOM. -->
        <div
          class="w-fit flex flex-col-reverse pointer-events-none"
          style:gap={bubbleGap(ui)}
          style:reading-flow="flex-visual"
          class:ml-auto={settingsState.getAlignment() === "right"}
          class:mr-auto={settingsState.getAlignment() === "left"}
          class:mx-auto={settingsState.getAlignment() === "center"}
        >
          <!-- Explicit visual stacking: a row that sits LOWER on screen paints
               over the rows above it (shadow included), like cards fanned
               upward. The column is flex-col-reverse (first DOM child at the
               bottom, which keeps the scroll anchor for autoscroll), so tree
               order paints bottom rows first; these descending z-indexes
               invert that. Each wrapper is its own stacking context, so
               within a row the bubble's z-0 shadow still sits under its z-10
               body. Pop-out UI (Modal, SnippetAutocomplete) carries its own
               z-50. -->
          <div class="relative pointer-events-none" style:z-index={messageGroups.length + 3}>
            <SessionBar />
          </div>

          <div class="relative pointer-events-none" style:z-index={messageGroups.length + 2}>
            <UserInput />
          </div>

          {#if sessionLoading}
            <div class="relative pointer-events-none" style:z-index={messageGroups.length + 1}>
              <Bubble
                selectedAlignment={settingsState.getAlignment()}
                borderColorClass="border-default-400"
                extraClass="flex items-center gap-2"
              >
                <i class="i-line-md:loading-alt-loop text-xl"></i>
                <span>Loading latest session…</span>
              </Bubble>
            </div>
          {/if}

          <!-- Force a clean teardown of the entire message subtree on every
               session boundary. Without the key, the cancelled tool's
               Expandable body (transition:expand|global) and the various
               per-component effects (auto-close, expansion-state writers,
               MessageStackGroup's effect.pre + transitionTimers) can race
               with `messages = []` and leave stale DOM behind after a
               delete-with-active-tool-call. The key bumps inside
               `sessionsState.resetAllSessionState`. -->
          {#key sessionsState.epoch}
            {#each messageGroups as group, gi (group.key)}
              <!-- Descending z down the transcript (gi 0 = newest = bottom):
                   see the stacking comment on the SessionBar wrapper above. -->
              <div class="relative pointer-events-none" style:z-index={messageGroups.length - gi}>
              {#if group.kind === "stack"}
                <MessageStackGroup messages={group.messages}>
                  {#snippet item({ msg, idx, neighborLeft, neighborRight })}
                    <MessageEnter
                      alignment={settingsState.getAlignment()}
                      msgId={msg.role === "loading"
                        ? undefined
                        : msgKey(msg, `g-${idx}`)}
                      delayMs={enterDelays.get(enterDelayKey(msg) ?? "") ?? 0}
                      class="pointer-events-none"
                    >
                      {#if msg.role === "loading"}
                        <Bubble
                          selectedAlignment={settingsState.getAlignment()}
                          size="small"
                          extraClass="flex items-center"
                          {neighborLeft}
                          {neighborRight}
                        >
                          <i class="i-line-md:loading-alt-loop text-base"></i>
                        </Bubble>
                      {:else if msg.role === "reasoning"}
                        <AgentMessage
                          kind="reasoning"
                          id={msg.id}
                          content={asMessageContent(msg.content)}
                          modelUsed={msg.modelUsed}
                          reasoningDurationMs={msg.reasoningDurationMs}
                          isStreaming={streamingState.isLive(msg.id)}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {:else if msg.role === "system"}
                        <SystemMessage
                          id={msg.id}
                          content={msg.content as string}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {:else if msg.role === "user"}
                        <AutomatedPrompt
                          id={msg.id}
                          content={getTextContent(asMessageContent(msg.content))}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {:else if msg.role === "tool"}
                        <ToolCall
                          id={msg.id}
                          {msg}
                          onAnswer={(requestId, answers) =>
                            toolkitsState.answerAskUser(
                              msg.callId!,
                              requestId,
                              answers,
                            )}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {:else if msg.role === "tool_filter"}
                        <RelevantTools
                          id={msg.id}
                          {msg}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {:else if msg.role === "memory_filter"}
                        <RelevantMemories
                          id={msg.id}
                          {msg}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {:else if msg.role === "display"}
                        {@const display = displayContentOf(msg)}
                        {#if display}
                          <DisplayBubble
                            id={msg.id}
                            content={display}
                            {neighborLeft}
                            {neighborRight}
                          />
                        {/if}
                      {/if}
                    </MessageEnter>
                  {/snippet}
                </MessageStackGroup>
              {:else}
                {@const msg = group.message}
                <MessageEnter
                  alignment={settingsState.getAlignment()}
                  msgId={msgKey(msg, group.key)}
                  delayMs={enterDelays.get(enterDelayKey(msg) ?? "") ?? 0}
                  class="relative pointer-events-none"
                >
                  {#if msg.role === "user"}
                    <UserMessage
                      content={asMessageContent(msg.content)}
                      editing={msg.id != null && msg.id === editingUserMsgId}
                      onStartEdit={() =>
                        (editingUserMsgId = msg.id ?? null)}
                      onStopEdit={() => (editingUserMsgId = null)}
                      onEdit={(newContent) =>
                        messagesState.updateUserMessage(msg.id, newContent)}
                      onReprocess={msg.id
                        ? () => messagesState.reprocessUserMessage(msg.id!)
                        : undefined}
                      onDelete={msg.id
                        ? () => messagesState.deleteUserMessage(msg.id!)
                        : undefined}
                    />
                  {:else if msg.role === "error"}
                    <ErrorMessage content={asMessageContent(msg.content)} />
                  {:else if msg.role === "assistant"}
                    <AgentMessage
                      kind="content"
                      id={msg.id}
                      content={assistantContent(msg)}
                      modelUsed={msg.modelUsed}
                      isStreaming={streamingState.isLive(msg.id)}
                      onReprocess={msg.id
                        ? () => messagesState.reprocessAgentMessage(msg.id!)
                        : undefined}
                      onDelete={msg.id
                        ? () => messagesState.deleteAgentMessage(msg.id!)
                        : undefined}
                    />
                  {/if}
                </MessageEnter>
              {/if}
              </div>
            {/each}
          {/key}
        </div>
      {:else}
        <div
          class="w-fit pointer-events-none"
          class:ml-auto={settingsState.getAlignment() === "right"}
          class:mr-auto={settingsState.getAlignment() === "left"}
          class:mx-auto={settingsState.getAlignment() === "center"}
        >
          {#if viewState.mode === "newCore"}
            <NewCore />
          {:else if viewState.mode === "quickSettings"}
            <QuickSettings />
          {:else if viewState.mode === "sessionList"}
            <SessionList />
          {:else}
            <Settings />
          {/if}
        </div>
      {/if}
    </div>
  </main>
  </div>
{/if}

<style lang="scss">
  :global(.no-scrollbar::-webkit-scrollbar) {
    display: none;
  }
  :global(.no-scrollbar) {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  :global(::selection) {
    background-color: rgba(0, 0, 0, 0.5);
    color: white;
  }
</style>
