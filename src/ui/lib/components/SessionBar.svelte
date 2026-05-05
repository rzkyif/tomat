<script lang="ts">
  import Bubble from "./Bubble.svelte";
  import { messagesState, sessionsState, settingsState } from "../state";
  import { getContextSize } from "$lib/sidecar/llm";
  import { hasAlpha } from "$lib/shared/color";

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

  // Context progress
  let contextMax = $derived(getContextSize());
  let contextUsed = $derived(messagesState.tokenUsage?.totalTokens || 0);
  let contextRatio = $derived(contextMax > 0 ? contextUsed / contextMax : 0);
  let contextColor = $derived(
    contextRatio < 0.5
      ? "bg-accent-green-200"
      : contextRatio < 0.75
        ? "bg-accent-yellow-200"
        : contextRatio < 0.9
          ? "bg-accent-orange-200"
          : "bg-accent-red-200",
  );

  function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
  }

  // Navigation
  let canPrev = $derived(sessionsState.currentIndex > 0);
  let canNext = $derived(
    sessionsState.currentIndex < sessionsState.list.length - 1,
  );

  let defaultTitle = $derived(sessionsState.defaultTitle);
  let isNewSession = $derived(messagesState.messages.length === 0);
  let storageEnabled = $derived(
    settingsState.currentSettings["general.session.storeSessions"] !== false,
  );

  let showTitle = $derived(!isNewSession && storageEnabled);
  let showButtonGroup = $derived(
    storageEnabled && (canPrev || canNext || !isNewSession),
  );
  let showBar = $derived(
    !!messagesState.tokenUsage || showTitle || showButtonGroup,
  );
  let alignment = $derived(settingsState.getAlignment());
</script>

{#if showBar}
  <div style:display="contents" style:--default-base={themeOverrideHex}>
  <Bubble
    selectedAlignment={alignment}
    size="small"
    extraClass={`flex items-center gap-2`}
  >
    {#if messagesState.tokenUsage}
      <!-- Context progress bar with text inside -->
      <div
        class="relative w-12 h-8 bg-default-200 rounded-large overflow-hidden shrink-0 border-0.25em border-default-200"
        title="Context: {formatTokens(contextUsed)} / {formatTokens(
          contextMax,
        )}"
      >
        <div
          class="{contextColor} w-full absolute bottom-0 transition-all duration-300"
          style="height: {Math.min(contextRatio * 100, 100)}%"
        ></div>
        <span
          class="absolute inset-0 flex items-center justify-center text-xs font-medium text-default-700 leading-none"
        >
          {Math.round(contextRatio * 100)}%
        </span>
      </div>
    {/if}

    <!-- Title (grid overlap technique for auto-sizing). The container is the
         only `min-w-0` flex item in the bubble; the context bar and button
         group are `shrink-0`, so it absorbs the squeeze when the bubble hits
         its own max-width cap. The invisible sizing span gets clipped by
         `overflow-hidden`, and the input shows an ellipsis when blurred so
         the user can still tell the title is truncated. -->
    {#if showTitle}
      <div
        class="grid items-center min-w-0 h-8 overflow-hidden bg-default-200 rounded-large text-sm"
      >
        <span
          class="invisible row-start-1 col-start-1 whitespace-pre px-3 py-1"
          aria-hidden="true">{titleText || defaultTitle}</span
        >
        <input
          size="1"
          aria-label="Session Title"
          bind:this={titleInput}
          bind:value={titleText}
          onfocus={handleTitleFocus}
          onblur={handleTitleBlur}
          onkeydown={handleTitleKeydown}
          placeholder={defaultTitle}
          class="row-start-1 col-start-1 w-full min-h-full px-3 py-1 text-default-700 flex items-center text-ellipsis"
        />
      </div>
    {/if}

    <!-- Session navigation -->
    {#if showButtonGroup}
      <div
        class="flex flex-row items-center justify-center bg-default-200 h-8 px-1 rounded-large shrink-0"
      >
        {#if canPrev}
          <button
            class="text-lg rounded p-0.5 flex items-center hover:text-default-900 hover:cursor-pointer text-default-700 transition-colors"
            onclick={() => {
              confirmingDelete = false;
              sessionsState.navigatePrev();
            }}
            title="Previous Session"
          >
            <i class="flex i-material-symbols-chevron-left-rounded"></i>
          </button>
        {/if}
        {#if canNext}
          <button
            class="text-lg rounded p-0.5 flex items-center hover:text-default-900 hover:cursor-pointer text-default-700 transition-colors"
            onclick={() => {
              confirmingDelete = false;
              sessionsState.navigateNext();
            }}
            title="Next Session"
          >
            <i class="flex i-material-symbols-chevron-right-rounded"></i>
          </button>
        {/if}
        {#if !isNewSession}
          <button
            data-delete-btn
            class="text-lg rounded p-0.5 flex items-center hover:cursor-pointer transition-colors {confirmingDelete
              ? 'text-default-700 hover:text-default-900'
              : 'text-default-700 hover:text-default-900'}"
            onclick={handleDeleteClick}
            title={confirmingDelete ? "Confirm Delete" : "Delete Session"}
          >
            <i
              class="flex {confirmingDelete
                ? 'i-material-symbols-delete-forever-rounded'
                : 'i-material-symbols-delete-outline-rounded'}"
            ></i>
          </button>
          <button
            class="text-lg rounded p-0.5 flex items-center hover:text-default-900 hover:cursor-pointer text-default-700 transition-colors"
            onclick={() => {
              confirmingDelete = false;
              sessionsState.create();
            }}
            title="New Session"
          >
            <i class="flex i-material-symbols-add-rounded"></i>
          </button>
        {/if}
      </div>
    {/if}
  </Bubble>
  </div>
{/if}
