<script lang="ts">
  import SessionBarView from "@tomat/shared/ui/components/chat/SessionBarView.svelte";
  import MessageEnter from "./MessageEnter.svelte";
  import {
    messagesState,
    sessionsState,
    settingsState,
    viewState,
  } from "../../state";
  import { hasAlpha } from "$lib/appearance/color";

  // The stacking z-index for this row, supplied by the chat column so a row
  // lower on screen paints over the ones above it. Owned here (not in a +page
  // wrapper) so a hidden bar leaves no empty flex item behind.
  let { zIndex }: { zIndex: number } = $props();

  // getContextSize lived in $lib/sidecar/llm and read from the LLM HTTP
  // /props endpoint. Context size is now reported by core; until the
  // /api/v1/llm/status endpoint exists this falls back to a static default
  // (8192 is the llama.cpp default for most models).
  function getContextSize(): number {
    return Number(settingsState.currentSettings["llm.contextSize"]) || 8192;
  }

  const themeOverride = $derived(
    settingsState.currentSettings[
      "appearance.sessionBarDefaultColor"
    ] as string,
  );
  const themeOverrideHex = $derived(
    hasAlpha(themeOverride) ? themeOverride : null,
  );

  let titleInput: HTMLInputElement | undefined = $state();
  let titleText = $state(sessionsState.title);
  let editingTitle = $state(false);
  let confirmingDelete = $state(false);

  // Sync title from state
  $effect(() => {
    if (!editingTitle) {
      titleText = sessionsState.title;
    }
  });

  function handleTitleFocus() {
    editingTitle = true;
    confirmingDelete = false;
  }

  function handleTitleBlur() {
    editingTitle = false;
    const trimmed = titleText.trim();
    if (!trimmed) {
      titleText = sessionsState.defaultTitle;
      sessionsState.updateTitle(titleText);
    } else if (trimmed !== sessionsState.title) {
      sessionsState.updateTitle(trimmed);
    }
  }

  function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      titleInput?.blur();
    }
  }

  // Cancel confirm-delete when any other interactive element is clicked/focused
  function handleWindowFocusIn(e: FocusEvent) {
    if (!confirmingDelete) return;
    const target = e.target as HTMLElement;
    if (!target.closest("[data-delete-btn]")) {
      confirmingDelete = false;
    }
  }

  $effect(() => {
    if (confirmingDelete) {
      window.addEventListener("focusin", handleWindowFocusIn, true);
      return () => {
        window.removeEventListener("focusin", handleWindowFocusIn, true);
      };
    }
  });

  function handleDeleteClick() {
    if (confirmingDelete) {
      confirmingDelete = false;
      sessionsState.delete();
    } else {
      confirmingDelete = true;
    }
  }

  // Context progress (the gauge itself lives in SessionBarView).
  let contextMax = $derived(getContextSize());
  let contextUsed = $derived(messagesState.tokenUsage?.total || 0);

  // Prev/next session targets. The list is newest-first, so "previous"
  // walks toward older sessions (higher index) and "next" toward newer
  // ones. currentIndex is -1 for a brand-new session not yet in the list;
  // treat that as sitting before the newest entry, so "previous" lands on
  // the newest stored session and "next" has nowhere to go.
  let prevSession = $derived(
    sessionsState.currentIndex === -1
      ? (sessionsState.list[0] ?? null)
      : (sessionsState.list[sessionsState.currentIndex + 1] ?? null),
  );
  let nextSession = $derived(
    sessionsState.currentIndex > 0
      ? (sessionsState.list[sessionsState.currentIndex - 1] ?? null)
      : null,
  );

  function goToSession(id: string) {
    confirmingDelete = false;
    void sessionsState.load(id);
  }

  let defaultTitle = $derived(sessionsState.defaultTitle);
  let isNewSession = $derived(messagesState.messages.length === 0);
  let storageEnabled = $derived(
    settingsState.currentSettings["general.session.storeSessions"] !== false,
  );

  let showTitle = $derived(!isNewSession && storageEnabled);
  // The session-list button only makes sense when there are stored sessions to
  // list. In a fresh new-chat with no existing sessions the whole bar stays
  // hidden. The only action (new session) is already the current state.
  let hasSessions = $derived(sessionsState.list.length > 0);
  let showButtonGroup = $derived(storageEnabled && hasSessions);
  let showBar = $derived(
    !!messagesState.tokenUsage || showTitle || showButtonGroup,
  );
</script>

{#snippet bar()}
  <SessionBarView
    tokenUsage={messagesState.tokenUsage
      ? { used: contextUsed, max: contextMax }
      : null}
    {showTitle}
    bind:titleText
    {defaultTitle}
    bind:titleInput
    onTitleFocus={handleTitleFocus}
    onTitleBlur={handleTitleBlur}
    onTitleKeydown={handleTitleKeydown}
    generatingTitle={sessionsState.generatingTitle}
    onRegenerateTitle={() => sessionsState.regenerateTitle()}
    {showButtonGroup}
    prevDisabled={!prevSession}
    nextDisabled={!nextSession}
    {isNewSession}
    {confirmingDelete}
    onList={() => {
      confirmingDelete = false;
      viewState.navigate("sessionList");
    }}
    onPrev={() => prevSession && goToSession(prevSession.id)}
    onNext={() => nextSession && goToSession(nextSession.id)}
    onDelete={handleDeleteClick}
    onNew={() => {
      confirmingDelete = false;
      sessionsState.create();
    }}
    baseColorOverride={themeOverrideHex}
  />
{/snippet}

{#if showBar}
  <div class="relative pointer-events-none" style:z-index={zIndex}>
    {#if settingsState.getAlignment() === "center"}
      <!-- Centered: the bar slides down from above the first time a session gains
           content (showBar false -> true). No msgId, so it animates on every such
           entry; the session-restore gate keeps a restored bar from animating on
           load. Off-center (left/right) it just appears, with no entry motion. -->
      <MessageEnter alignment="center" centerDirection="down">
        {@render bar()}
      </MessageEnter>
    {:else}
      {@render bar()}
    {/if}
  </div>
{/if}
