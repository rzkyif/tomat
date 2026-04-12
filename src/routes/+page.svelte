<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import AgentMessage from "$lib/components/AgentMessage.svelte";
  import ErrorMessage from "$lib/components/ErrorMessage.svelte";
  import UserInput from "$lib/components/UserInput.svelte";
  import UserMessage from "$lib/components/UserMessage.svelte";
  import SessionBar from "$lib/components/SessionBar.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import { messagesState, serversState, settingsState } from "$lib/state";
  import {
    applyTheme,
    applyTextSize,
    listenSystemTheme,
  } from "$lib/state/appearance.svelte";
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
  let container: HTMLElement | undefined = $state();
  let contentEl: HTMLElement | undefined = $state();

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
  let cleanupSystemTheme: (() => void) | null = null;

  onMount(async () => {
    try {
      await settingsState.loadSettings();

      // Apply appearance before showing window to avoid flash
      applyTheme(settingsState.currentSettings["appearance.theme"] ?? "auto");
      applyTextSize(settingsState.currentSettings["appearance.textSize"] ?? 20);
      cleanupSystemTheme = listenSystemTheme(() => {
        if (settingsState.currentSettings["appearance.theme"] === "auto") {
          applyTheme("auto");
        }
      });
      if (settingsState.currentSettings["general.session.alwaysStartNew"]) {
        await messagesState.loadSessionList();
      } else {
        await messagesState.loadLatest();
      }
      document.addEventListener("click", linkHandler);

      // Initial sidecar startup
      await setupSidecarListeners();
      // Bun sidecar is started by Rust setup(), others triggered here:
      restartServerIfNeed("llm");
      restartServerIfNeed("stt");

      await positionWindow();
    } finally {
      // Always render content and show the window, even if setup partially
      // failed or was aborted by a Vite HMR reload mid-onMount.
      loaded = true;
      await tick();
      await invoke("show_main_window");

      if (contentEl) {
        await startClickThrough(contentEl);
      }

      // Pause/resume click-through when window visibility changes
      unlistenVisibility = await listen<boolean>(
        "window-visibility",
        ({ payload: visible }) => {
          if (visible) {
            resumeClickThrough();
          } else {
            pauseClickThrough();
          }
        },
      );
    }
  });

  onDestroy(() => {
    document.removeEventListener("click", linkHandler);
    stopClickThrough();
    unlistenVisibility?.();
    cleanupSystemTheme?.();
  });

  function toggleSettings() {
    showSettings = !showSettings;
    if (!showSettings) {
      setTimeout(() => scrollToBottom(), 0);
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

  // Find the index of the last user message (messages are newest-first)
  let lastUserMsgIndex = $derived(
    messagesState.messages.findIndex((m) => m.role === "user"),
  );
</script>

{#if loaded}
  <main
    bind:this={container}
    class="no-scrollbar flex flex-col-reverse justify-start p-10 text-default-800 max-w-screen min-h-screen max-h-screen overflow-x-clip overflow-y-auto"
    class:mx-auto={settingsState.getAlignment() === "center"}
    class:ml-auto={settingsState.getAlignment() === "right"}
    class:mr-auto={settingsState.getAlignment() === "left"}
  >
    <div bind:this={contentEl} class="flex flex-col-reverse gap-2 my-auto">
      {#if showSettings}
        <Settings {toggleSettings} />
      {:else}
        <div
          style="position: relative; z-index: {messagesState.messages.length +
            3};"
        >
          <SessionBar />
        </div>

        <div
          style="position: relative; z-index: {messagesState.messages.length +
            2};"
        >
          <UserInput {toggleSettings} {showSettings} />
        </div>

        {#each messagesState.messages as msg, i}
          <div
            style="position: relative; z-index: {messagesState.messages.length -
              i};"
          >
            {#if msg.role === "user"}
              <UserMessage
                content={msg.content}
                isLast={i === lastUserMsgIndex}
                onEdit={(newContent) =>
                  messagesState.updateLastUserMessage(newContent)}
              />
            {:else if msg.role === "error"}
              <ErrorMessage content={msg.content} />
            {:else if msg.role === "assistant"}
              <AgentMessage content={msg.content} />
            {/if}
          </div>
        {/each}
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
