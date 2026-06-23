<script lang="ts">
  import Bubble from "../primitives/Bubble.svelte";
  import ButtonGroup from "../primitives/ButtonGroup.svelte";
  import IconButton from "../primitives/IconButton.svelte";
  import { useUiContext } from "../../context.ts";

  // The session bar: a small bubble carrying the context-usage gauge, the
  // (editable) session title, and session navigation. All behaviour (title
  // editing, regenerate, delete-confirm, navigation) is owned by the client
  // wrapper and supplied via props/binds; the website feeds static values.
  // Alignment comes from the UI context so both apps match. (Which core you're
  // on is shown by the CoreBar, not here.)
  const ui = useUiContext();

  let {
    tokenUsage = null,
    showTitle = false,
    titleText = $bindable(""),
    defaultTitle = "",
    titleInput = $bindable(),
    onTitleFocus,
    onTitleBlur,
    onTitleKeydown,
    generatingTitle = false,
    onRegenerateTitle,
    showButtonGroup = false,
    prevDisabled = false,
    nextDisabled = false,
    isNewSession = false,
    confirmingDelete = false,
    onList,
    onPrev,
    onNext,
    onDelete,
    onNew,
    baseColorOverride = null,
  }: {
    /** Context-window usage; null hides the gauge. */
    tokenUsage?: { used: number; max: number } | null;
    showTitle?: boolean;
    titleText?: string;
    defaultTitle?: string;
    titleInput?: HTMLInputElement;
    onTitleFocus?: () => void;
    onTitleBlur?: () => void;
    onTitleKeydown?: (e: KeyboardEvent) => void;
    generatingTitle?: boolean;
    onRegenerateTitle?: () => void;
    showButtonGroup?: boolean;
    prevDisabled?: boolean;
    nextDisabled?: boolean;
    isNewSession?: boolean;
    confirmingDelete?: boolean;
    onList?: () => void;
    onPrev?: () => void;
    onNext?: () => void;
    onDelete?: () => void;
    onNew?: () => void;
    /** Per-surface base-color override hex (appearance.sessionBarDefaultColor). */
    baseColorOverride?: string | null;
  } = $props();

  const contextRatio = $derived(
    tokenUsage && tokenUsage.max > 0 ? tokenUsage.used / tokenUsage.max : 0,
  );
  const contextColor = $derived(
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
</script>

<div style:display="contents" style:--default-base={baseColorOverride}>
  <Bubble selectedAlignment={ui.getAlignment()} size="small" extraClass="flex items-center gap-2">
    {#if tokenUsage}
      <div
        data-region="context-gauge"
        class="relative w-12 h-8 bg-surface-inset rounded-large overflow-hidden shrink-0 border-0.25em border-default-200"
        title="Context: {formatTokens(tokenUsage.used)} / {formatTokens(tokenUsage.max)}"
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

    {#if showTitle}
      <!-- Title (grid overlap technique for auto-sizing). The container is the
           only `min-w-0` flex item, so it absorbs the squeeze when the bubble
           hits its max width; the invisible span sizes it and the input shows an
           ellipsis when blurred. -->
      <div
        class="tomat-focus-wrap flex items-center min-w-0 h-8 overflow-hidden bg-surface-inset rounded-large text-sm"
      >
        <div class="grid items-center min-w-0 overflow-hidden">
          <span
            class="invisible row-start-1 col-start-1 whitespace-pre pl-3 pr-1 py-1"
            aria-hidden="true">{titleText || defaultTitle}</span
          >
          <input
            size="1"
            aria-label="Session Title"
            bind:this={titleInput}
            bind:value={titleText}
            onfocus={() => onTitleFocus?.()}
            onblur={() => onTitleBlur?.()}
            onkeydown={(e) => onTitleKeydown?.(e)}
            placeholder={defaultTitle}
            class="row-start-1 col-start-1 w-full min-h-full pl-3 pr-1 py-1 text-default-700 flex items-center text-ellipsis"
          />
        </div>
        <IconButton
          icon={generatingTitle
            ? "i-material-symbols-progress-activity animate-spin"
            : "i-material-symbols-auto-awesome-rounded"}
          title={generatingTitle ? "Generating Title…" : "Regenerate Title"}
          size="sm"
          disabled={generatingTitle}
          class="mr-2"
          onclick={() => onRegenerateTitle?.()}
        />
      </div>
    {/if}

    {#if showButtonGroup}
      <ButtonGroup size="sm" class="shrink-0">
        <IconButton
          icon="i-material-symbols-format-list-bulleted-rounded"
          title="Session List"
          size="sm"
          onclick={() => onList?.()}
        />
        <IconButton
          icon="i-material-symbols-chevron-left-rounded"
          title="Previous Session"
          size="sm"
          disabled={prevDisabled}
          onclick={() => onPrev?.()}
        />
        <IconButton
          icon="i-material-symbols-chevron-right-rounded"
          title="Next Session"
          size="sm"
          disabled={nextDisabled}
          onclick={() => onNext?.()}
        />
        {#if !isNewSession}
          <IconButton
            icon={confirmingDelete
              ? "i-material-symbols-delete-forever-rounded"
              : "i-material-symbols-delete-outline-rounded"}
            title={confirmingDelete ? "Confirm Delete" : "Delete Session"}
            size="sm"
            onclick={() => onDelete?.()}
            data-delete-btn
          />
          <IconButton
            icon="i-material-symbols-add-rounded"
            title="New Session"
            size="sm"
            onclick={() => onNew?.()}
          />
        {/if}
      </ButtonGroup>
    {/if}
  </Bubble>
</div>
