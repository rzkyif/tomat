<script lang="ts">
  import { onMount } from "svelte";
  import Bubble from "../ui/Bubble.svelte";
  import Chip from "../ui/Chip.svelte";
  import ButtonGroup from "../ui/ButtonGroup.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import {
    messagesState,
    sessionsState,
    settingsState,
    viewState,
  } from "../../state";
  import { cores } from "$lib/core";
  import { hasAlpha } from "$lib/shared/color";

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

  // Active-core chip: shown only when more than one core is paired, so with a
  // single core the bar matches the original, coreless look.
  let coreCount = $state(0);
  let coreName = $state("");
  async function refreshCore(): Promise<void> {
    try {
      coreCount = (await cores().list()).length;
      coreName = cores().currentEntry()?.name ?? "";
    } catch {
      /* settings not readable yet */
    }
  }
  onMount(() => {
    void refreshCore();
    const unsub = cores().subscribe(() => void refreshCore());
    return () => unsub();
  });

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
  let contextUsed = $derived(messagesState.tokenUsage?.total || 0);
  let contextRatio = $derived(contextMax > 0 ? contextUsed / contextMax : 0);
  let contextColor = $derived(
    contextRatio < 0.5
      ? "bg-accent-green-200"
      : contextRatio < 0.9
        ? "bg-accent-yellow-200"
        : "bg-accent-red-200",
  );

  function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
  }

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
        class="relative w-12 h-8 bg-surface-inset rounded-large overflow-hidden shrink-0 border-0.25em border-default-200"
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
    {#if coreCount > 1}
      <Chip
        icon="i-material-symbols-hub-rounded"
        label={coreName}
        title="Sessions on this core"
        truncate
        labelMaxWidth="8rem"
      />
    {/if}

    {#if showTitle}
      <div
        class="grid items-center min-w-0 h-8 overflow-hidden bg-surface-inset rounded-large text-sm"
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
      <ButtonGroup size="sm" class="shrink-0">
        <IconButton
          icon="i-material-symbols-format-list-bulleted-rounded"
          title="Session List"
          size="sm"
          onclick={() => {
            confirmingDelete = false;
            viewState.navigate("sessionList");
          }}
        />
        <IconButton
          icon="i-material-symbols-chevron-left-rounded"
          title="Previous Session"
          size="sm"
          disabled={!prevSession}
          onclick={() => prevSession && goToSession(prevSession.id)}
        />
        <IconButton
          icon="i-material-symbols-chevron-right-rounded"
          title="Next Session"
          size="sm"
          disabled={!nextSession}
          onclick={() => nextSession && goToSession(nextSession.id)}
        />
        {#if !isNewSession}
          <IconButton
            icon={confirmingDelete
              ? "i-material-symbols-delete-forever-rounded"
              : "i-material-symbols-delete-outline-rounded"}
            title={confirmingDelete ? "Confirm Delete" : "Delete Session"}
            size="sm"
            onclick={handleDeleteClick}
            data-delete-btn
          />
          <IconButton
            icon="i-material-symbols-add-rounded"
            title="New Session"
            size="sm"
            onclick={() => {
              confirmingDelete = false;
              sessionsState.create();
            }}
          />
        {/if}
      </ButtonGroup>
    {/if}
  </Bubble>
  </div>
{/if}
