<script lang="ts">
  import type { Snippet } from "svelte";
  import Bubble from "../primitives/Bubble.svelte";
  import IconButton from "../primitives/IconButton.svelte";
  import QuickModelBarView from "./userinput/QuickModelBarView.svelte";
  import { useUiContext } from "../../context.ts";
  import type { Alignment } from "../../types.ts";
  import { findField, getDefaultSettings } from "../../../domain/settings/engine.ts";
  import type { ModelPresetField } from "../../../domain/settings/types.ts";
  import {
    creativityDropdownOptions,
    creativitySelection,
    CUSTOM_VALUE,
    type QuickOption,
    type QuickSelection,
    thinkingDropdownOptions,
    thinkingSelection,
  } from "../../../domain/quick-controls.ts";

  // The composer shell: the input bubble with its auto-growing textarea and the
  // three control groups (attach/capture | monitor/align/settings | voice/send),
  // plus the quick-model bar below the textarea. This View OWNS the canonical
  // default composition, so a bare render (no host overrides) matches the client
  // at default settings: the quick-model bar is always present, and the Voice
  // Input button follows `stt.enabled` from the UI context. The client passes
  // LIVE state for both (its `belowContent` quick bar + explicit voice props);
  // the website passes nothing and inherits the defaults. This is what keeps
  // every website rendition in lockstep with the client instead of each caller
  // hand-picking which controls appear (the source of the past drift). All
  // behaviour (VAD/STT, autocomplete, screenshots, sending) and the client-only
  // modes (permission/schedule prompts, the autocorrect alert) still arrive as
  // props/snippets. Alignment comes from the UI context.
  const ui = useUiContext();

  // Default quick-model bar: a fresh app's controls (provider local, the default
  // preset, default thinking/creativity), derived from the schema defaults via
  // the same shared helpers the client's live QuickModelBar uses, so the rendered
  // markup is single-source. Rendered only when the host supplies no `belowContent`
  // override (i.e. every non-client host); the controls are inert (onchange noop).
  const noop = (): void => {};
  const dqDefaults = getDefaultSettings();
  const dqContextSize = Number(dqDefaults["llm.contextSize"]) || 4096;
  const dqPresetField = findField("llm.preset") as ModelPresetField | undefined;
  const dqPresetOptions = (dqPresetField?.presetConfig.options ?? []).map((o) => ({
    value: o.id,
    label: o.title ?? o.label,
  }));
  function dqWithCustom(sel: QuickSelection, options: QuickOption[]): QuickOption[] {
    if (sel.value !== CUSTOM_VALUE) return options;
    const label = sel.customLabel ?? "";
    return [{ value: CUSTOM_VALUE, label, display: label, disabled: true }, ...options];
  }
  const dqThinking = thinkingSelection(dqDefaults, "local");
  const dqThinkingOpts = dqWithCustom(dqThinking, thinkingDropdownOptions("local", dqContextSize));
  const dqCreativity = creativitySelection(dqDefaults);
  const dqCreativityOpts = dqWithCustom(dqCreativity, creativityDropdownOptions());

  type MonitorOption = { id: string | number; name: string };
  type CaptureMonitorOption = { id: string | number; name: string; isPrimary: boolean };

  let {
    baseColorOverride = null,
    onBubbleClick,
    // Default text content (replaced by `contentOverride` when supplied).
    value = $bindable(""),
    placeholder = "",
    textareaDisabled = false,
    textareaRef = $bindable(),
    mirrorRef = $bindable(),
    onkeydown,
    oninput,
    onkeyup,
    ontextareaclick,
    oncompositionstart,
    oncompositionend,
    ontextareablur,
    onpaste,
    topSlot,
    contentOverride,
    belowContent,
    attachmentSlot,
    // Left group (attach + screen capture). Hidden in prompt modes.
    showLeftGroup = true,
    onAttach,
    captureMonitors = [],
    onCaptureSelect,
    capturing = false,
    onCaptureRegion,
    // Center group (monitor select + alignment + settings).
    monitors = [],
    selectedMonitor = "primary",
    onMonitorChange,
    onAlign,
    settingsTitle = "Settings",
    gearTone,
    onSettings,
    // Right group: voice + send, or a custom slot (permission/schedule buttons).
    rightSlot,
    // When the host leaves `showVoice` unset, the button's presence follows
    // `stt.enabled` from the UI context (default on), matching the client.
    showVoice = undefined,
    voiceTitle = "Voice Input",
    voiceClass = "",
    voiceDisabled = false,
    onVoiceToggle,
    pttHolding = false,
    pttHoldDuration = 0,
    vadEnabled = false,
    vadListening = false,
    sttIdle = true,
    hasActiveWork = false,
    hasContent = false,
    sendDisabled = false,
    onSend,
    onStop,
    onInterruptAndSend,
  }: {
    baseColorOverride?: string | null;
    onBubbleClick?: (e: MouseEvent) => void;
    value?: string;
    placeholder?: string;
    textareaDisabled?: boolean;
    textareaRef?: HTMLTextAreaElement;
    mirrorRef?: HTMLElement;
    onkeydown?: (e: KeyboardEvent) => void;
    oninput?: (e: Event) => void;
    onkeyup?: (e: KeyboardEvent) => void;
    ontextareaclick?: (e: MouseEvent) => void;
    oncompositionstart?: (e: CompositionEvent) => void;
    oncompositionend?: (e: CompositionEvent) => void;
    ontextareablur?: (e: FocusEvent) => void;
    onpaste?: (e: ClipboardEvent) => void;
    topSlot?: Snippet;
    contentOverride?: Snippet;
    belowContent?: Snippet;
    attachmentSlot?: Snippet;
    showLeftGroup?: boolean;
    onAttach?: () => void;
    captureMonitors?: CaptureMonitorOption[];
    onCaptureSelect?: (e: Event) => void;
    capturing?: boolean;
    onCaptureRegion?: () => void;
    monitors?: MonitorOption[];
    selectedMonitor?: string;
    onMonitorChange?: (e: Event) => void;
    onAlign?: (value: Alignment) => void;
    settingsTitle?: string;
    gearTone?: string;
    onSettings?: () => void;
    rightSlot?: Snippet;
    showVoice?: boolean;
    voiceTitle?: string;
    voiceClass?: string;
    voiceDisabled?: boolean;
    onVoiceToggle?: () => void;
    pttHolding?: boolean;
    pttHoldDuration?: number;
    vadEnabled?: boolean;
    vadListening?: boolean;
    sttIdle?: boolean;
    hasActiveWork?: boolean;
    hasContent?: boolean;
    sendDisabled?: boolean;
    onSend?: () => void;
    onStop?: () => void;
    onInterruptAndSend?: () => void;
  } = $props();

  // Voice button presence: explicit host value wins; otherwise follow the
  // context's `stt.enabled` (so the website's default render matches the client).
  const effShowVoice = $derived(showVoice ?? ui.sttEnabled);

  const ALIGNMENTS = [
    { value: "left", icon: "i-material-symbols-format-align-left-rounded", title: "Align Left" },
    {
      value: "center",
      icon: "i-material-symbols-format-align-center-rounded",
      title: "Align Center",
    },
    { value: "right", icon: "i-material-symbols-format-align-right-rounded", title: "Align Right" },
  ] as const;
</script>

<div style:display="contents" style:--default-base={baseColorOverride}>
  <Bubble
    selectedAlignment={ui.getAlignment()}
    extraClass="flex flex-col gap-4 min-w-0 overflow-hidden transition-all"
    onclick={onBubbleClick}
  >
    {@render topSlot?.()}

    {#if contentOverride}
      {@render contentOverride()}
    {:else}
      <div class="grid w-fit min-w-0 max-w-[calc(100vw-135px)] overflow-clip">
        <!-- Hidden span: mirrors the typed text so the grid auto-sizes width and
             height, and doubles as the autocomplete caret-measurement layer. -->
        <span
          bind:this={mirrorRef}
          class="invisible whitespace-pre-wrap break-words wrap-break-word col-start-1 row-start-1 pointer-events-none"
          >{value ? value + "​" : placeholder}</span
        >
        <textarea
          aria-label="Message input"
          bind:this={textareaRef}
          bind:value
          onkeydown={onkeydown}
          oninput={oninput}
          onkeyup={onkeyup}
          onclick={ontextareaclick}
          oncompositionstart={oncompositionstart}
          oncompositionend={oncompositionend}
          onblur={ontextareablur}
          onpaste={onpaste}
          autocapitalize="on"
          autocomplete="off"
          rows="1"
          cols="1"
          class="tomat-no-focus-ring col-start-1 row-start-1 bg-transparent outline-none min-w-0 w-full max-w-[calc(100vw-80px)] max-w-full overflow-hidden resize-none whitespace-pre-wrap break-words placeholder:text-default-400"
          {placeholder}
          disabled={textareaDisabled}
        ></textarea>
      </div>
      {#if belowContent}
        {@render belowContent()}
      {:else}
        <!-- Default quick-model bar (see the script header): the canonical
             always-present control row a fresh app shows, built from schema
             defaults. The client overrides this via `belowContent` with its
             live, wired QuickModelBar. -->
        <QuickModelBarView
          model={{
            value: dqDefaults["llm.preset"] as string,
            options: dqPresetOptions,
            onchange: noop,
            ariaLabel: "Smart preset",
          }}
          thinking={{ value: dqThinking.value, options: dqThinkingOpts, onchange: noop }}
          creativity={{ value: dqCreativity.value, options: dqCreativityOpts, onchange: noop }}
        />
      {/if}
    {/if}

    {@render attachmentSlot?.()}

    <div class="flex items-end justify-between gap-2 text-2xl text-default-700 w-full">
      {#if showLeftGroup}
        <div class="flex items-center bg-surface-inset rounded-large p-1">
          <IconButton
            icon="i-material-symbols-attach-file-rounded"
            title="Attach File"
            size="lg-tight"
            onclick={() => onAttach?.()}
          />

          <!-- Screen capture: an icon with an overlaid monitor <select>. A
               <select> can't live in a <button>, so this matches IconButton's
               lg-tight sizing (p-1 text-xl) by hand. -->
          <div
            class="tomat-focus-wrap relative flex items-center justify-center shrink-0 p-1 text-xl text-default-700 hov:text-default-900 act:text-default-900 hov:bg-surface-inset act:bg-surface-inset-strong rounded transition-interactive"
          >
            <i class="flex i-material-symbols-screenshot-monitor-outline-rounded"></i>
            <select
              class="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base"
              title="Screen Capture"
              aria-label="Screen Capture Monitor"
              onchange={onCaptureSelect}
              disabled={capturing}
              value=""
            >
              <option value="" disabled>Select Monitor</option>
              {#each captureMonitors as mon (mon.id)}
                <option value={mon.id}>{mon.name}{mon.isPrimary ? " (Primary)" : ""}</option>
              {/each}
            </select>
          </div>

          <IconButton
            icon="i-material-symbols-crop-free-rounded"
            title="Capture Region"
            ariaLabel="Capture Screen Region"
            size="lg-tight"
            disabled={capturing}
            onclick={() => onCaptureRegion?.()}
          />
        </div>
      {/if}

      <div class="flex items-center bg-surface-inset rounded-large p-1">
        <div
          class="tomat-focus-wrap relative flex items-center justify-center shrink-0 p-1 text-xl text-default-700 hov:text-default-900 act:text-default-900 hov:bg-surface-inset act:bg-surface-inset-strong rounded transition-interactive"
        >
          <i class="flex i-material-symbols-desktop-windows-outline-rounded"></i>
          <select
            class="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base"
            onchange={onMonitorChange}
            value={selectedMonitor}
          >
            <option value="primary">Primary Monitor</option>
            {#each monitors as monitor (monitor.id)}
              <option value={monitor.id}>{monitor.name}</option>
            {/each}
          </select>
        </div>

        <div class="flex items-center">
          {#each ALIGNMENTS as align (align.value)}
            <IconButton
              icon={align.icon}
              title={align.title}
              size="lg-tight"
              onclick={() => onAlign?.(align.value)}
            />
          {/each}
        </div>

        <IconButton
          icon="i-material-symbols-settings-outline-rounded"
          title={settingsTitle}
          colorClass={gearTone}
          size="lg-tight"
          onclick={() => onSettings?.()}
          class="transition-colors duration-500"
        />
      </div>

      <div class="flex gap-2">
        {#if rightSlot}
          {@render rightSlot()}
        {:else}
          {#if effShowVoice}
            <IconButton
              data-region="voice"
              size="lg"
              surface="filled"
              title={voiceTitle}
              class="rounded-large"
              colorClass={voiceClass || undefined}
              disabled={voiceDisabled}
              onclick={() => onVoiceToggle?.()}
            >
              {#snippet icon()}
                {#if pttHolding}
                  <svg
                    class="ptt-ring flex w-[1em] h-[1em] text-default-700"
                    style="--ptt-duration: {pttHoldDuration}ms"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      pathLength="100"
                      stroke-dasharray="100"
                      stroke-dashoffset="100"
                      transform="rotate(-90 12 12)"
                    />
                  </svg>
                {:else}
                  <i
                    class="flex {vadEnabled
                      ? vadListening
                        ? 'i-line-md:loading-twotone-loop'
                        : 'i-material-symbols-mic-rounded'
                      : sttIdle
                        ? 'i-material-symbols-mic-outline-rounded'
                        : 'i-material-symbols-mic-off-outline-rounded'}"
                  ></i>
                {/if}
              {/snippet}
            </IconButton>
          {/if}
          <IconButton
            icon={hasActiveWork && !hasContent
              ? "i-material-symbols-stop-rounded"
              : hasActiveWork && hasContent
                ? "i-material-symbols-arrow-upward-rounded"
                : "i-material-symbols-send-outline-rounded"}
            size="lg"
            surface="filled"
            title={hasActiveWork && !hasContent
              ? "Stop"
              : hasActiveWork && hasContent
                ? "Interrupt and Send"
                : "Send"}
            class="rounded-large"
            colorClass={hasActiveWork && !hasContent
              ? "text-accent-red-500 hov:text-accent-red-400"
              : undefined}
            disabled={sendDisabled}
            onclick={hasActiveWork && !hasContent
              ? () => onStop?.()
              : hasActiveWork && hasContent
                ? () => onInterruptAndSend?.()
                : () => onSend?.()}
          />
        {/if}
      </div>
    </div>
  </Bubble>
</div>

<style>
  /* Push-to-talk hold ring: fills from 0% to 100% over the configured hold
     duration. The SVG mounts only while held, so the keyframes run from the
     start; release-before-fill simply unmounts it. `pathLength="100"` keeps the
     dasharray math in percent regardless of the circle's circumference. */
  .ptt-ring circle {
    animation: ptt-ring-fill var(--ptt-duration) linear forwards;
  }
  @keyframes ptt-ring-fill {
    to {
      stroke-dashoffset: 0;
    }
  }
</style>
