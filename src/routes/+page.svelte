<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import AgentMessage from "$lib/components/messages/AgentMessage.svelte";
  import ErrorMessage from "$lib/components/messages/ErrorMessage.svelte";
  import SystemMessage from "$lib/components/messages/SystemMessage.svelte";
  import UserInput from "$lib/components/input/UserInput.svelte";
  import UserMessage from "$lib/components/messages/UserMessage.svelte";
  import SessionBar from "$lib/components/SessionBar.svelte";
  import Settings from "$lib/components/settings/Settings.svelte";
  import Bubble from "$lib/components/Bubble.svelte";
  import {
    messagesState,
    serversState,
    settingsState,
    snippetsState,
  } from "$lib/state";
  import { shortcutHandler } from "$lib/state/shortcut.svelte";
  import {
    applyTheme,
    applyTextSize,
    listenSystemTheme,
  } from "$lib/state/appearance.svelte";
  import {
    messageEnter,
    slidePanel,
    enableMessageAnimations,
    getDuration,
    pinPanelForOutro,
  } from "$lib/shared/animations";
  import {
    setupSidecarListeners,
    restartServerIfNeed,
  } from "$lib/sidecar/manager";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    startClickThrough,
    stopClickThrough,
    pauseClickThrough,
    resumeClickThrough,
  } from "$lib/shared/clickthrough";
  import { listen } from "@tauri-apps/api/event";

  let showSettings = $state(false);
  let loaded = $state(false);
  let sessionLoading = $state(true);
  let container: HTMLElement | undefined = $state();
  let contentEl: HTMLElement | undefined = $state();

  // Window show/hide slide state. Drives the transform + opacity of `main`
  // between visible ("in") and off-screen ("out").
  let windowSlide = $state<"in" | "out">("in");
  let hidingInFlight = false;

  // Gates the whole visual treatment. Stays false until the app's first
  // show completes. While false, `main` is kept at opacity 0 with no
  // transform; on first show we fade it in (no slide on startup, since
  // the slide's percent-translate resolves against a width that isn't
  // fully settled on the very first paint after Rust unhides the window).
  // Subsequent show/hide uses the full slide — `main`'s layout is stable
  // by then so percent-translate works correctly.
  let initialShown = $state(false);

  function hideOffsetTransform(alignment: "left" | "center" | "right") {
    if (alignment === "left") return "translateX(-100%)";
    if (alignment === "right") return "translateX(100%)";
    return "translateY(100%)";
  }

  async function animateHideThenHide() {
    if (hidingInFlight) return;
    hidingInFlight = true;
    windowSlide = "out";
    await new Promise((r) => setTimeout(r, getDuration()));
    try {
      await invoke("hide_main_window");
    } catch (e) {
      console.warn("[window] hide failed:", e);
    }
    hidingInFlight = false;
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
        openUrl(anchor.href);
      }
    }
  };

  async function positionWindow() {
    try {
      await invoke("position_window", {
        monitorId: settingsState.getMonitor(),
        alignment: settingsState.getAlignment(),
        width: settingsState.currentSettings["layout.width"] || 700,
      });
    } catch (e) {
      console.error("Failed to position window", e);
    }
  }

  let unlistenVisibility: (() => void) | null = null;
  let unlistenMonitor: (() => void) | null = null;
  let unlistenHideRequested: (() => void) | null = null;
  let cleanupSystemTheme: (() => void) | null = null;

  onMount(async () => {
    // Critical path: only the work needed to paint a correctly-themed,
    // correctly-positioned window runs before `show_main_window`. Everything
    // else (session load, snippets, sidecar wiring, TTS) is deferred so
    // first paint is not blocked on it.
    try {
      await settingsState.loadSettings();

      applyTheme(settingsState.currentSettings["appearance.theme"] ?? "auto");
      applyTextSize(settingsState.currentSettings["appearance.textSize"] ?? 20);

      // Only show the "Loading latest session…" placeholder when we're
      // actually about to load one; "always start new" mode has nothing to
      // load so the placeholder would be misleading.
      sessionLoading =
        !settingsState.currentSettings["general.session.alwaysStartNew"];

      await positionWindow();
    } finally {
      loaded = true;
      await tick();
      await invoke("show_main_window");
      // The `window-visibility: true` event emitted by `show_main_window`
      // fires before the listener below is registered, so flip the gate
      // here directly — this triggers the fade-in on first show.
      initialShown = true;
    }

    // Post-paint work. Fire-and-forget; the window is already visible.
    document.addEventListener("click", linkHandler);

    cleanupSystemTheme = listenSystemTheme(() => {
      if (settingsState.currentSettings["appearance.theme"] === "auto") {
        applyTheme("auto");
      }
    });

    if (contentEl) {
      void startClickThrough(contentEl);
    }

    listen<boolean>("window-visibility", ({ payload: visible }) => {
      if (visible) {
        windowSlide = "in";
        resumeClickThrough();
      } else {
        pauseClickThrough();
      }
    }).then((unlisten) => {
      unlistenVisibility = unlisten;
    });

    listen("window-hide-requested", () => {
      void animateHideThenHide();
    }).then((unlisten) => {
      unlistenHideRequested = unlisten;
    });

    listen("monitor-changed", () => {
      if (loaded) positionWindow();
    }).then((unlisten) => {
      unlistenMonitor = unlisten;
    });

    // Global-shortcut listener lives here (not in UserInput) so it stays
    // attached when the user is in the Settings view — otherwise the
    // shortcut silently stops working whenever UserInput is unmounted.
    void shortcutHandler.attach();

    // Sidecar listeners + kick off llm/stt. The bun sidecar starts from Rust
    // setup(); setupSidecarListeners() seeds a snapshot so events missed
    // during this delay are not lost.
    setupSidecarListeners()
      .then(() => {
        restartServerIfNeed("llm");
        restartServerIfNeed("stt");
      })
      .catch((e) => console.warn("setupSidecarListeners:", e));

    void snippetsState.load();

    // Session load runs async with a visible "Loading latest session…"
    // placeholder above the user input until it resolves.
    (async () => {
      try {
        if (settingsState.currentSettings["general.session.alwaysStartNew"]) {
          await messagesState.loadSessionList();
        } else {
          await messagesState.loadLatest();
        }
      } catch (e) {
        console.warn("session load:", e);
      } finally {
        sessionLoading = false;
        // Enable per-message entry animations only AFTER the bulk restore
        // completes — otherwise 50 messages all animate in at once.
        await tick();
        enableMessageAnimations();
      }
    })();

    // If TTS was left enabled in persisted settings, load the model now.
    if (settingsState.currentSettings["tts.enabled"]) {
      void import("$lib/state/tts.svelte").then(({ ttsState }) => {
        void ttsState.setEnabled(true);
      });
    }
  });

  onDestroy(() => {
    document.removeEventListener("click", linkHandler);
    stopClickThrough();
    shortcutHandler.detach();
    unlistenVisibility?.();
    unlistenMonitor?.();
    unlistenHideRequested?.();
    cleanupSystemTheme?.();
  });

  function toggleSettings() {
    // Pin the currently-visible panel to its exact viewport position BEFORE
    // flipping showSettings. Otherwise the incoming panel mounts first, its
    // size re-centers `my-auto` on contentEl, and the outgoing panel has
    // already drifted by the time its outro transition runs.
    const current = contentEl?.firstElementChild as
      | HTMLElement
      | null
      | undefined;
    pinPanelForOutro(current);

    showSettings = !showSettings;
    if (!showSettings) {
      // Wait for the panel slide-out + slide-in sequence (2x base duration)
      // before scrolling; otherwise the chat is still off-screen.
      setTimeout(() => scrollToBottom(), getDuration() * 2);
    }
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
    const theme = settingsState.currentSettings["appearance.theme"];
    if (loaded && theme) applyTheme(theme);
  });

  $effect(() => {
    const size = settingsState.currentSettings["appearance.textSize"];
    if (loaded && size) applyTextSize(size as number);
  });

  async function scrollToBottom() {
    await tick();
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
    }
  }

  // Find the index of the last user message (messages are newest-first).
  // Use visibleMessages - the last user message always sits within the window
  // after a send, and callers index against the rendered list.
  let lastUserMsgIndex = $derived(
    messagesState.visibleMessages.findIndex((m) => m.role === "user"),
  );
</script>

{#if loaded}
  <main
    bind:this={container}
    class="no-scrollbar flex flex-col-reverse justify-start p-10 text-default-800 w-fit max-w-screen min-h-screen max-h-screen overflow-x-clip overflow-y-auto"
    class:mx-auto={settingsState.getAlignment() === "center"}
    class:ml-auto={settingsState.getAlignment() === "right"}
    class:mr-auto={settingsState.getAlignment() === "left"}
    style:transform={initialShown && windowSlide === "out"
      ? hideOffsetTransform(settingsState.getAlignment())
      : undefined}
    style:opacity={initialShown && windowSlide === "in" ? "1" : "0"}
    style:transition={`transform ${getDuration()}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${getDuration()}ms cubic-bezier(0.4, 0, 0.2, 1)`}
  >
    <div bind:this={contentEl} class="flex flex-col-reverse gap-2 my-auto">
      {#if showSettings}
        <div
          class="w-fit"
          class:ml-auto={settingsState.getAlignment() === "right"}
          class:mr-auto={settingsState.getAlignment() === "left"}
          class:mx-auto={settingsState.getAlignment() === "center"}
          in:slidePanel={{
            alignment: settingsState.getAlignment(),
            direction: "in",
          }}
          out:slidePanel={{
            alignment: settingsState.getAlignment(),
            direction: "out",
          }}
        >
          <Settings {toggleSettings} />
        </div>
      {:else}
        <div
          class="w-fit flex flex-col-reverse gap-2"
          class:ml-auto={settingsState.getAlignment() === "right"}
          class:mr-auto={settingsState.getAlignment() === "left"}
          class:mx-auto={settingsState.getAlignment() === "center"}
          in:slidePanel={{
            alignment: settingsState.getAlignment(),
            direction: "in",
          }}
          out:slidePanel={{
            alignment: settingsState.getAlignment(),
            direction: "out",
          }}
        >
          <div
            class="relative"
            style="z-index: {messagesState.visibleMessages.length + 3};"
          >
            <SessionBar />
          </div>

          <div
            class="relative"
            style="z-index: {messagesState.visibleMessages.length + 2};"
          >
            <UserInput {toggleSettings} {showSettings} />
          </div>

          {#if sessionLoading}
            <div
              class="relative"
              style="z-index: {messagesState.visibleMessages.length + 1};"
            >
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

          {#each messagesState.visibleMessages as msg, i (msg.id ?? i)}
            <div
              class="relative"
              style="z-index: {messagesState.visibleMessages.length - i};"
              in:messageEnter|local={{
                alignment: settingsState.getAlignment(),
              }}
              out:messageEnter|local={{
                alignment: settingsState.getAlignment(),
              }}
            >
              {#if msg.role === "user"}
                <UserMessage
                  content={msg.content}
                  isLast={i === lastUserMsgIndex}
                  onEdit={(newContent) =>
                    messagesState.updateUserMessage(msg.id, newContent)}
                  onDelete={msg.id
                    ? () => messagesState.deleteUserMessage(msg.id!)
                    : undefined}
                />
              {:else if msg.role === "error"}
                <ErrorMessage content={msg.content} />
              {:else if msg.role === "assistant"}
                <AgentMessage
                  id={msg.id}
                  content={msg.content}
                  modelUsed={msg.modelUsed}
                  reasoning={msg.reasoning}
                  reasoningDurationMs={msg.reasoningDurationMs}
                  pending={messagesState.isStreaming &&
                    messagesState.streamingMessageId === msg.id &&
                    !messagesState.streamingFirstChunkReceived}
                  isStreaming={messagesState.isStreaming &&
                    messagesState.streamingMessageId === msg.id}
                  onReprocess={msg.id
                    ? () => messagesState.reprocessAgentMessage(msg.id!)
                    : undefined}
                  onDelete={msg.id
                    ? () => messagesState.deleteAgentMessage(msg.id!)
                    : undefined}
                />
              {:else if msg.role === "system"}
                <SystemMessage content={msg.content as string} />
              {/if}
            </div>
          {/each}
          {#if messagesState.hasMoreMessages}
            <button
              type="button"
              class="mx-auto my-2 px-3 py-1 text-sm text-default-600 hover:text-default-900 rounded bg-default-100 hover:bg-default-200"
              onclick={() => messagesState.loadMoreMessages()}
            >
              Load older messages
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </main>
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
