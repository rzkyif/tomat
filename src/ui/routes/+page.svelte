<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import AgentMessage from "$lib/components/messages/AgentMessage.svelte";
  import ErrorMessage from "$lib/components/messages/ErrorMessage.svelte";
  import SystemMessage from "$lib/components/messages/SystemMessage.svelte";
  import ToolCall from "$lib/components/messages/ToolCall.svelte";
  import RelevantTools from "$lib/components/messages/RelevantTools.svelte";
  import UserInput from "$lib/components/input/UserInput.svelte";
  import UserMessage from "$lib/components/messages/UserMessage.svelte";
  import SessionBar from "$lib/components/SessionBar.svelte";
  import Settings from "$lib/components/settings/Settings.svelte";
  import Bubble from "$lib/components/Bubble.svelte";
  import MessageStackGroup from "$lib/components/MessageStackGroup.svelte";
  import { getTextContent, type Message } from "$lib/shared/types";
  import {
    downloadsState,
    messagesState,
    serversState,
    sessionsState,
    settingsState,
    snippetsState,
    streamingState,
    toolkitsState,
  } from "$lib/state";
  import { detectPendingStartup } from "$lib/shared/download";
  import {
    shortcutHandler,
    windowTransition,
  } from "$lib/state/shortcut.svelte";
  import {
    enableMessageAnimations,
    getDuration,
  } from "$lib/shared/animations";
  import MessageEnter from "$lib/components/MessageEnter.svelte";
  import {
    setupSidecarListeners,
    startConfiguredServices,
  } from "$lib/sidecar/manager";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    startClickThrough,
    stopClickThrough,
    pauseClickThrough,
    resumeClickThrough,
  } from "$lib/shared/clickthrough";
  import { listen } from "@tauri-apps/api/event";

  // Visual preferences applied directly to documentElement: theme class for
  // dark mode, root font size for the rem-based scale. SSR is off (see
  // +layout.ts) so it's safe to touch `window` and `document` at module
  // evaluation time.
  const themeMql = window.matchMedia("(prefers-color-scheme: dark)");

  function applyTheme(theme: string) {
    const isDark = theme === "dark" || (theme === "auto" && themeMql.matches);
    document.documentElement.classList.toggle("dark", isDark);
  }

  function applyTextSize(size: number) {
    document.documentElement.style.fontSize = `${size}px`;
  }

  function applyBubbleColor(cssVar: string, hex: string | undefined) {
    if (typeof hex !== "string" || hex.length === 0) return;
    document.documentElement.style.setProperty(cssVar, hex);
  }

  function applyCssVarPx(cssVar: string, value: number | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    document.documentElement.style.setProperty(cssVar, `${value}px`);
  }

  function listenSystemTheme(callback: () => void): () => void {
    themeMql.addEventListener("change", callback);
    return () => themeMql.removeEventListener("change", callback);
  }

  let showSettings = $state(false);
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

  // Imperatively drive the window-level slide+fade on `container`. Mirrors
  // the same JS+CSS pattern used for panel swap (`toggleSettings`): set
  // transition then target style; the WKWebView transition fires reliably
  // because the source value is already on the element.
  //   - "visible":   on screen, fully opaque
  //   - "offscreen": slid out per alignment, fully transparent
  // First paint inlines opacity:0 directly on the element so the window
  // doesn't flash visible before the first applyWindowState() runs.
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
      container.style.transform = offscreenTransform(
        settingsState.getAlignment(),
      );
      container.style.opacity = "0";
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
      await invoke("hide_main_window");
    } catch (e) {
      console.warn("[window] hide failed:", e);
    } finally {
      hidingInFlight = false;
      windowTransition.end();
    }
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
      // Seed bundled sample toolkits into ~/.tomat/toolkits/ on first run.
      // Subsequent runs no-op because seed_sample_toolkits skips existing
      // entries.
      invoke("seed_sample_toolkits").catch((e) =>
        console.warn("seed_sample_toolkits:", e),
      );
      // Connect to the sidecar's WS channel for tool-call events in the
      // background; the toolkits state auto-reconnects if the sidecar
      // restarts.
      void toolkitsState.ensureConnected();

      applyTheme(settingsState.currentSettings["appearance.theme"] ?? "auto");
      applyTextSize(settingsState.currentSettings["appearance.textSize"] ?? 20);
      applyBubbleColor(
        "--user-bubble-bg-light",
        settingsState.currentSettings["appearance.userBubbleColor"],
      );
      applyBubbleColor(
        "--agent-bubble-bg-light",
        settingsState.currentSettings["appearance.agentBubbleColor"],
      );
      applyBubbleColor(
        "--agent2-bubble-bg-light",
        settingsState.currentSettings["appearance.secondaryAgentBubbleColor"],
      );
      applyBubbleColor(
        "--default-base",
        settingsState.currentSettings["appearance.defaultColor"],
      );
      applyBubbleColor(
        "--accent-red-base",
        settingsState.currentSettings["appearance.accentRed"],
      );
      applyBubbleColor(
        "--accent-blue-base",
        settingsState.currentSettings["appearance.accentBlue"],
      );
      applyBubbleColor(
        "--accent-purple-base",
        settingsState.currentSettings["appearance.accentPurple"],
      );
      applyBubbleColor(
        "--accent-green-base",
        settingsState.currentSettings["appearance.accentGreen"],
      );
      applyBubbleColor(
        "--accent-orange-base",
        settingsState.currentSettings["appearance.accentOrange"],
      );
      applyBubbleColor(
        "--accent-yellow-base",
        settingsState.currentSettings["appearance.accentYellow"],
      );
      applyCssVarPx(
        "--rounded-small",
        settingsState.currentSettings["appearance.roundedSmall"] as number,
      );
      applyCssVarPx(
        "--rounded-medium",
        settingsState.currentSettings["appearance.roundedMedium"] as number,
      );
      applyCssVarPx(
        "--rounded-large",
        settingsState.currentSettings["appearance.roundedLarge"] as number,
      );

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
      // fires before the listener below is registered, so kick off the
      // fade-in here directly.
      applyWindowState("visible", true);
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
        applyWindowState("visible", true);
        resumeClickThrough();
        // Mirror the slide-in animation duration so spammed shortcut presses
        // can't reverse the in-progress show into a hide and flicker.
        windowTransition.begin();
        setTimeout(() => windowTransition.end(), getDuration());
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
    setupSidecarListeners()
      .catch((e) => console.warn("setupSidecarListeners:", e))
      .finally(async () => {
        try {
          const { plans, groupBySource } = await detectPendingStartup(
            settingsState.currentSettings,
          );
          if (plans.length > 0) {
            downloadsState.pendingStartup = plans;
            downloadsState.pendingStartupGroupBySource = groupBySource;
            // Don't start sidecars or TTS yet - the Settings modal will
            // do that in its onConfirm once the user approves the batch.
            return;
          }
          startConfiguredServices();
        } catch (e) {
          console.warn("detectPendingStartup:", e);
        }
      });

    void snippetsState.load();

    // Session load runs async with a visible "Loading latest session…"
    // placeholder above the user input until it resolves.
    (async () => {
      try {
        if (settingsState.currentSettings["general.session.alwaysStartNew"]) {
          await sessionsState.loadList();
        } else {
          await sessionsState.loadLatest();
        }
      } catch (e) {
        console.warn("session load:", e);
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
    shortcutHandler.detach();
    unlistenVisibility?.();
    unlistenMonitor?.();
    unlistenHideRequested?.();
    cleanupSystemTheme?.();
  });

  async function toggleSettings() {
    if (panelToggling) return;
    panelToggling = true;

    const dur = getDuration();
    const layer = panelLayer;

    if (layer && dur > 0) {
      const offscreen = offscreenTransform(settingsState.getAlignment());
      const transitionStyle = `transform ${dur}ms cubic-bezier(0.4, 0, 0.2, 1)`;

      // Phase 1: slide the wrapper (and everything inside, including the
      // mounted panel) offscreen.
      layer.style.transition = transitionStyle;
      layer.style.transform = offscreen;
      await new Promise((r) => setTimeout(r, dur));

      // Phase 2: swap content. The wrapper stays at the offscreen transform,
      // so the new panel mounts already offscreen with no extra positioning.
      showSettings = !showSettings;
      await tick();

      // Phase 3: slide the wrapper back to its natural position.
      layer.style.transform = "";
      await new Promise((r) => setTimeout(r, dur));
      layer.style.transition = "";
    } else {
      showSettings = !showSettings;
    }

    panelToggling = false;
    if (!showSettings) scrollToBottom();
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

  $effect(() => {
    const v = settingsState.currentSettings["appearance.userBubbleColor"];
    if (loaded) applyBubbleColor("--user-bubble-bg-light", v);
  });

  $effect(() => {
    const v = settingsState.currentSettings["appearance.agentBubbleColor"];
    if (loaded) applyBubbleColor("--agent-bubble-bg-light", v);
  });

  $effect(() => {
    const v =
      settingsState.currentSettings["appearance.secondaryAgentBubbleColor"];
    if (loaded) applyBubbleColor("--agent2-bubble-bg-light", v);
  });

  $effect(() => {
    const v = settingsState.currentSettings["appearance.defaultColor"];
    if (loaded) applyBubbleColor("--default-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentRed"];
    if (loaded) applyBubbleColor("--accent-red-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentBlue"];
    if (loaded) applyBubbleColor("--accent-blue-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentPurple"];
    if (loaded) applyBubbleColor("--accent-purple-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentGreen"];
    if (loaded) applyBubbleColor("--accent-green-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentOrange"];
    if (loaded) applyBubbleColor("--accent-orange-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.accentYellow"];
    if (loaded) applyBubbleColor("--accent-yellow-base", v);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.roundedSmall"];
    if (loaded) applyCssVarPx("--rounded-small", v as number);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.roundedMedium"];
    if (loaded) applyCssVarPx("--rounded-medium", v as number);
  });
  $effect(() => {
    const v = settingsState.currentSettings["appearance.roundedLarge"];
    if (loaded) applyCssVarPx("--rounded-large", v as number);
  });

  async function scrollToBottom() {
    await tick();
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
    }
  }

  // Find the most recent user message (messages is newest-first).
  // Used by UserMessage to decide whether it's the last sent message and
  // should default to its inline-edit state.
  let lastUserMsg = $derived(
    messagesState.messages.find((m) => m.role === "user"),
  );

  // Visible while the assistant turn is in flight but we haven't received
  // anything yet, neither reasoning nor content. Drives a transient
  // small-bubble spinner so the user has a visual cue between sending and
  // first-token arrival. As soon as either reasoning or content fires, this
  // turns false and the corresponding real bubble takes over.
  let showStreamingLoadingBubble = $derived(
    streamingState.isActive &&
      streamingState.messageId !== null &&
      streamingState.reasoningId === null &&
      !streamingState.firstChunkReceived,
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
    if (msg.role === "tool" && msg.toolCall) return true;
    if (msg.role === "tool_filter" && msg.relevantTools) return true;
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
  // loading sentinel at the newest position when we're awaiting the first
  // response chunk. That lets it stack with adjacent small bubbles
  // (tool_filter, reasoning, system) via the existing grouping pipeline
  // instead of being a standalone element outside it.
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
      return !isEmptyAssistant && !isHiddenReasoning && !isHiddenSystem;
    });
    if (showStreamingLoadingBubble) {
      const loadingMsg: Message = {
        id: LOADING_MSG_ID,
        role: "loading",
        content: "",
      };
      return [loadingMsg, ...real];
    }
    return real;
  });

  function msgKey(msg: Message, fallback: string): string {
    return msg.id ?? msg.toolCall?.callId ?? fallback;
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
      {#if showSettings}
        <div
          class="w-fit pointer-events-none"
          class:ml-auto={settingsState.getAlignment() === "right"}
          class:mr-auto={settingsState.getAlignment() === "left"}
          class:mx-auto={settingsState.getAlignment() === "center"}
        >
          <Settings {toggleSettings} />
        </div>
      {:else}
        <div
          class="w-fit flex flex-col-reverse gap-2 pointer-events-none"
          class:ml-auto={settingsState.getAlignment() === "right"}
          class:mr-auto={settingsState.getAlignment() === "left"}
          class:mx-auto={settingsState.getAlignment() === "center"}
        >
          <div class="relative pointer-events-none z-30">
            <SessionBar />
          </div>

          <div class="relative pointer-events-none z-20">
            <UserInput {toggleSettings} {showSettings} />
          </div>

          {#if sessionLoading}
            <div class="relative pointer-events-none z-10">
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
            {#each messageGroups as group (group.key)}
              {#if group.kind === "stack"}
                <MessageStackGroup messages={group.messages}>
                  {#snippet item({ msg, idx, neighborLeft, neighborRight })}
                    <MessageEnter
                      alignment={settingsState.getAlignment()}
                      msgId={msg.role === "loading"
                        ? undefined
                        : msgKey(msg, `g-${idx}`)}
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
                          content={msg.content}
                          modelUsed={msg.modelUsed}
                          reasoningDurationMs={msg.reasoningDurationMs}
                          isStreaming={streamingState.isActive &&
                            streamingState.reasoningId === msg.id}
                          onDelete={msg.id
                            ? () =>
                                messagesState.deleteReasoningMessage(msg.id!)
                            : undefined}
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
                      {:else if msg.role === "tool" && msg.toolCall}
                        <ToolCall
                          id={msg.id}
                          toolCall={msg.toolCall}
                          onAnswer={(requestId, answers) =>
                            toolkitsState.answerAskUser(
                              msg.toolCall!.callId,
                              requestId,
                              answers,
                            )}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {:else if msg.role === "tool_filter" && msg.relevantTools}
                        <RelevantTools
                          id={msg.id}
                          relevantTools={msg.relevantTools}
                          {neighborLeft}
                          {neighborRight}
                        />
                      {/if}
                    </MessageEnter>
                  {/snippet}
                </MessageStackGroup>
              {:else}
                {@const msg = group.message}
                <MessageEnter
                  alignment={settingsState.getAlignment()}
                  msgId={msgKey(msg, group.key)}
                  class="relative pointer-events-none"
                >
                  {#if msg.role === "user"}
                    <UserMessage
                      content={msg.content}
                      isLast={msg === lastUserMsg}
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
                      kind="content"
                      id={msg.id}
                      content={msg.content}
                      modelUsed={msg.modelUsed}
                      isStreaming={streamingState.isActive &&
                        streamingState.messageId === msg.id}
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
            {/each}
          {/key}
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
