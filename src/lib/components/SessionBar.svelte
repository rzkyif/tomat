<script lang="ts">
  import Bubble from "./Bubble.svelte";
  import { messagesState, settingsState } from "../state";
  import { getContextSize } from "$lib/sidecar/llm";

  let titleInput: HTMLInputElement | undefined = $state();
  let titleText = $state(messagesState.sessionTitle);
  let editingTitle = $state(false);
  let confirmingDelete = $state(false);

  // Sync title from state
  $effect(() => {
    if (!editingTitle) {
      titleText = messagesState.sessionTitle;
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
      titleText = messagesState.getDefaultTitle();
      messagesState.updateTitle(titleText);
    } else if (trimmed !== messagesState.sessionTitle) {
      messagesState.updateTitle(trimmed);
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
      messagesState.deleteSession();
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
      ? "bg-ctx-green"
      : contextRatio < 0.75
        ? "bg-ctx-yellow"
        : contextRatio < 0.9
          ? "bg-ctx-orange"
          : "bg-ctx-red",
  );

  function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
  }

  // Navigation
  let canPrev = $derived(messagesState.currentSessionIndex > 0);
  let canNext = $derived(
    messagesState.currentSessionIndex < messagesState.sessionList.length - 1,
  );

  let defaultTitle = $derived(messagesState.getDefaultTitle());
  let isNewSession = $derived(messagesState.messages.length === 0);
  let storageEnabled = $derived(
    settingsState.currentSettings["behaviour.storeSessions"] !== false,
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
  <Bubble
    selectedAlignment={alignment}
    paddingClass="px-3 py-2"
    extraClass={`flex items-center gap-2 max-w-full`}
  >
    {#if messagesState.tokenUsage}
      <!-- Context progress bar with text inside -->
      <div
        class="relative w-16 h-10 bg-default-100 rounded-2xl overflow-hidden shrink-0 border-0.35em border-default-100"
        title="Context: {formatTokens(contextUsed)} / {formatTokens(
          contextMax,
        )}"
      >
        <div
          class="{contextColor} w-full absolute bottom-0 transition-all duration-300"
          style="height: {Math.min(contextRatio * 100, 100)}%"
        ></div>
        <span
          class="absolute inset-0 flex items-center justify-center text-sm font-medium text-default-500 leading-none"
        >
          {Math.round(contextRatio * 100)}%
        </span>
      </div>
    {/if}

    <!-- Title (grid overlap technique for auto-sizing) -->
    {#if showTitle}
      <div
        class="grid items-center min-w-0 overflow-hidden bg-default-100 rounded-2xl"
      >
        <span
          class="invisible row-start-1 col-start-1 whitespace-pre px-4 py-2"
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
          class="row-start-1 col-start-1 w-full min-h-full px-4 py-2 text-default-500 flex items-center"
        />
      </div>
    {/if}

    <!-- Session navigation -->
    {#if showButtonGroup}
      <div
        class="flex flex-row items-center justify-center bg-default-100 px-2 py-1 rounded-2xl shrink-0"
      >
        {#if canPrev}
          <button
            class="text-2xl rounded p-1 flex items-center hover:text-default-900 hover:cursor-pointer text-default-500 transition-colors"
            onclick={() => {
              confirmingDelete = false;
              messagesState.navigatePrev();
            }}
            title="Previous Session"
          >
            <i class="flex i-material-symbols-chevron-left-rounded"></i>
          </button>
        {/if}
        {#if canNext}
          <button
            class="text-2xl rounded p-1 flex items-center hover:text-default-900 hover:cursor-pointer text-default-500 transition-colors"
            onclick={() => {
              confirmingDelete = false;
              messagesState.navigateNext();
            }}
            title="Next Session"
          >
            <i class="flex i-material-symbols-chevron-right-rounded"></i>
          </button>
        {/if}
        {#if !isNewSession}
          <button
            data-delete-btn
            class="text-2xl rounded p-1 flex items-center hover:cursor-pointer transition-colors {confirmingDelete
              ? 'text-default-500 hover:text-default-900'
              : 'text-default-500 hover:text-default-900'}"
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
            class="text-2xl rounded p-1 flex items-center hover:text-default-900 hover:cursor-pointer text-default-500 transition-colors"
            onclick={() => {
              confirmingDelete = false;
              messagesState.newSession();
            }}
            title="New Session"
          >
            <i class="flex i-material-symbols-add-rounded"></i>
          </button>
        {/if}
      </div>
    {/if}
  </Bubble>
{/if}
