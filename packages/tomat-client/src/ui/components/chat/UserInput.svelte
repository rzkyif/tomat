<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { Alignment, Monitor, Attachment, MessagePart } from "$lib/util/types";
  import { platform } from "$lib/platform";
  import { useUiContext } from "@tomat/shared/ui/context";
  import {
    downloadsState,
    messagesState,
    permissionState,
    scheduleConfirmState,
    memoriesState,
    mcpState,
    serversState,
    sessionsState,
    settingsState,
    snippetsState,
    streamingState,
    viewState,
  } from "../../state";
  import { connectionState } from "$stores/connection.svelte";
  import { getLogger } from "$lib/util/log";

  const log = getLogger("user-input");
  const attachLog = getLogger("attach");
  const uiLog = getLogger("ui");

  const ui = useUiContext();
  const onMobile = ui.platform === "mobile";

  async function sendMessages(_anchorUserId?: string): Promise<void> {
    // Trigger the server-side chat turn. The streaming state subscribes
    // to chat.* frames and mutates the message list as content arrives.
    streamingState.beginTurn(_anchorUserId ?? null);
    streamingState.start();
  }

  // Edit / reprocess flows in messagesState regenerate a turn by calling
  // back into this dispatch (see the handler note in messages.svelte.ts).
  messagesState.setLLMHandlers(sendMessages);

  import { applySnippets, snippetTrigger } from "$lib/snippets/snippets";
  import {
    type AutocompleteOption,
    collectExistingTriggers,
    useAutocomplete,
  } from "$composables/use-autocomplete.svelte";
  import { useStt } from "$composables/use-stt-input.svelte";
  import { memoryTrigger } from "$stores/memories.svelte";
  import {
    applySystemPromptOverride,
    buildContextBlock,
    buildSystemPromptBase,
  } from "$lib/prompts/system-prompt";
  import SnippetAutocomplete from "./SnippetAutocomplete.svelte";
  import { ComposerAttachments } from "$composables/use-composer-attachments.svelte";
  import { InputShortcuts } from "$composables/use-input-shortcuts.svelte";
  import { PromptModes } from "$composables/use-prompt-modes.svelte";
  import { vadManager } from "$stores/vad.svelte";
  import { shortcutHandler } from "$stores/shortcut.svelte";
  import { useBlink } from "$composables/use-blink.svelte";
  import type { ActivationMode } from "@tomat/shared";
  import AttachmentList from "./AttachmentList.svelte";
  import QuickModelBar from "./userinput/QuickModelBar.svelte";
  import AutocorrectAlert from "./userinput/AutocorrectAlert.svelte";
  import PermissionRequest from "./userinput/PermissionRequest.svelte";
  import ScheduleConfirmForm from "./userinput/ScheduleConfirmForm.svelte";
  import UserInputView from "@tomat/shared/ui/components/chat/UserInputView.svelte";
  import PromptButtonsView from "@tomat/shared/ui/components/chat/userinput/PromptButtonsView.svelte";
  import Modal from "@tomat/shared/ui/components/primitives/Modal.svelte";
  import { hasAlpha } from "$lib/appearance/color";

  const themeOverride = $derived(
    settingsState.currentSettings["appearance.userInputDefaultColor"] as string,
  );
  const themeOverrideHex = $derived(hasAlpha(themeOverride) ? themeOverride : null);

  let text = $state("");
  let monitors: Monitor[] = $state([]);
  let textareaElement: HTMLTextAreaElement | undefined = $state();
  let mirrorSpan: HTMLSpanElement | undefined = $state();

  // The composer's attachment pipeline (pending list, pickers, paste, capture,
  // image preview) is its own stateful unit; this component owns the lifecycle
  // (monitor fetch in onMount) and the `attachmentParts` derived, and supplies
  // the refocus hook.
  const composer = new ComposerAttachments({
    onMobile,
    focus: () => focusInput(),
  });

  // The `@trigger` autocomplete dropdown and the speech-to-text pipeline are
  // each their own stateful unit; this component owns the lifecycle wiring (see
  // onMount / the effects below) and the option list, which spans two stores.
  const ac = useAutocomplete();
  ac.bind(
    () => textareaElement,
    () => mirrorSpan,
  );
  const stt = useStt();

  // OS-level input shortcuts (attach/capture), armed only while mounted and the
  // window is visible; this component drives register/clear from its visibility
  // subscription in onMount. The schedule-confirm prompt's editable draft lives
  // in its own unit; this component keeps the $derived pending reads and the
  // $effect that mirrors the pending frame into the draft.
  const inputShortcuts = new InputShortcuts();
  const prompt = new PromptModes();

  let autocompleteOptions = $derived.by<AutocompleteOption[]>(() => {
    if (!ac.open) return [];
    const prefix = ac.prefix.toLowerCase();
    const existing = collectExistingTriggers(text, ac.triggerStart, ac.triggerEnd);
    // The leading symbol the user typed (`#`/`@`/`/`) picks the source list:
    // snippets match by their full trigger so only the right symbol passes;
    // memories are `@`-only references.
    const snippets = snippetsState.snippets
      .map((s) => ({ snippet: s, trigger: snippetTrigger(s) }))
      .filter(({ snippet, trigger }) => {
        if (!trigger.toLowerCase().startsWith(prefix)) return false;
        // insert-user snippets are explicitly designed to be dropped inline
        // multiple times, so don't filter them out even if already present.
        if (snippet.placement !== "insert-user" && existing.has(trigger.toLowerCase())) {
          return false;
        }
        return true;
      })
      .map<AutocompleteOption>(({ snippet, trigger }) => ({
        id: `snippet:${snippet.id}`,
        name: snippet.name,
        trigger,
        source: "snippet",
      }));
    const snippetTriggers = new Set(
      snippetsState.snippets.map((s) => snippetTrigger(s).toLowerCase()),
    );
    const memories = memoriesState.memories
      .filter((d) => d.enabled)
      .map((d) => ({ memory: d, trigger: memoryTrigger(d) }))
      .filter(
        ({ trigger }) =>
          trigger.toLowerCase().startsWith(prefix) &&
          !existing.has(trigger.toLowerCase()) &&
          !snippetTriggers.has(trigger.toLowerCase()),
      )
      .sort((a, b) => a.trigger.localeCompare(b.trigger))
      .map<AutocompleteOption>(({ memory, trigger }) => ({
        id: `memory:${memory.id}`,
        name: memory.title,
        trigger,
        source: "memory",
      }));
    // MCP prompts trigger with "/" (enabled ones only); MCP resources are
    // "@"-referenceable. Both resolve core-side at send.
    const mcpResSlug = (n: string) =>
      `@${n
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}`;
    const mcpPrompts = mcpState.prompts
      .filter((p) => p.enabled)
      .map((p) => ({ p, trigger: `/${p.name}` }))
      .filter(
        ({ trigger }) =>
          trigger.toLowerCase().startsWith(prefix) && !existing.has(trigger.toLowerCase()),
      )
      .map<AutocompleteOption>(({ p, trigger }) => ({
        id: `mcp_prompt:${p.serverId}:${p.name}`,
        name: p.serverName,
        trigger,
        source: "mcp_prompt",
      }));
    const mcpResources = mcpState.resources
      .map((r) => ({ r, trigger: mcpResSlug(r.name) }))
      .filter(
        ({ trigger }) =>
          trigger.toLowerCase().startsWith(prefix) &&
          !existing.has(trigger.toLowerCase()) &&
          !snippetTriggers.has(trigger.toLowerCase()),
      )
      .map<AutocompleteOption>(({ r, trigger }) => ({
        id: `resource:${r.serverId}:${r.uri}`,
        name: r.name,
        trigger,
        source: "resource",
      }));
    return [...snippets, ...memories, ...mcpPrompts, ...mcpResources];
  });

  $effect(() => {
    ac.clampIndex(autocompleteOptions.length);
  });

  // Transient status notice shown through the textarea placeholder. Chat
  // mode has no room for banners or badges: short, plain-language messages
  // ("Transcription failed! Please try again.") surface where the user is
  // already looking, then clear on their own. Details go to the logs.
  let inputNotice = $state<string | null>(null);
  let inputNoticeTimeout: ReturnType<typeof setTimeout> | null = null;

  function showInputNotice(message: string, ms = 5000) {
    inputNotice = message;
    if (inputNoticeTimeout) clearTimeout(inputNoticeTimeout);
    inputNoticeTimeout = setTimeout(() => {
      inputNotice = null;
    }, ms);
  }

  let llmStatus = $derived(serversState.serverStatuses.llama.status);

  // Pulses the gear yellow while there are pending startup downloads and
  // Settings is closed. Yellow sits at the 700/900 lightness levels so it
  // matches the adjacent default-700 icon buttons, just yellow-tinted. Interval
  // matches the IconButton's duration-500 so the color is always mid-tween. See
  // useBlink.
  const settingsBlink = useBlink();
  $effect(() => settingsBlink.run(downloadsState.hasPending));
  const gearTone = $derived(
    downloadsState.hasPending
      ? settingsBlink.on
        ? "text-accent-yellow-900"
        : "text-accent-yellow-700"
      : undefined,
  );
  // True whenever the user has something to interrupt: either an LLM stream
  // or an active tool call (running or awaiting input). Drives the stop button
  // so tool calls can be aborted the same way streams are.
  let hasActiveWork = $derived(streamingState.hasActiveWork);

  // Permission mode: a running tool is paused on a permission it was not
  // always-allowed. The text input area shows the request instead of the
  // textarea; attach/voice/send controls hide; X and check buttons to the
  // right of the settings group decide. The accept applies to this tool
  // call only ("always allow" lives in the Extension detail view).
  let permissionRequest = $derived(permissionState.pending);

  // Schedule-confirm mode: a running tool proposed a scheduled prompt and is
  // paused on this editable form. Mirrors the permission mode: the textarea
  // is replaced by the form, attach/voice/send controls hide, X and check
  // buttons decide. The user's edits ride back on the accept.
  let scheduleConfirm = $derived(scheduleConfirmState.pending);
  $effect(() => {
    // The pending frame is reactive deep state, so its draft is a Proxy;
    // structuredClone would throw DataCloneError on it. $state.snapshot
    // returns a plain editable clone (the same call the accept path uses).
    prompt.scheduleDraft = scheduleConfirm ? $state.snapshot(scheduleConfirm.draft) : null;
  });

  let hasContent = $derived(text.trim().length > 0 || composer.attachments.length > 0);

  let placeholderText = $derived(
    inputNotice
      ? inputNotice
      : connectionState.reconnecting
        ? "Reconnecting to Core..."
        : downloadsState.hasPending
          ? "Pending download, open settings!"
          : downloadsState.loading
            ? "Connecting to Core..."
            : stt.processing
              ? "Transcribing..."
              : vadManager.enabled && vadManager.listening
                ? "Listening..."
                : vadManager.enabled
                  ? "Waiting for speech..."
                  : llmStatus === "Error"
                    ? "Failed to start LLM server!!"
                    : llmStatus === "Loading"
                      ? "Waiting for LLM server..."
                      : "Enter your instructions...",
  );
  let sttStatus = $derived(serversState.serverStatuses.speech.status);

  let attachmentParts = $derived(
    composer.attachments.map((att): MessagePart => {
      if (att.type === "image") {
        return {
          type: "image_url",
          image_url: {
            url: `data:${att.mime || "image/png"};base64,${att.pendingData}`,
          },
        };
      }
      return {
        type: "document",
        filename: att.filename,
        markdown: att.pendingData,
      };
    }),
  );

  function applySnippetTrigger(option: { trigger: string }) {
    const ta = textareaElement;
    const result = ac.applyTrigger(text, option.trigger);
    if (!result) return;
    text = result.text;
    const caret = result.caret;
    // Restore caret position after Svelte updates the DOM value.
    queueMicrotask(() => {
      ta?.focus();
      ta?.setSelectionRange(caret, caret);
    });
  }

  function handleCompositionStart() {
    ac.onCompositionStart();
  }

  function handleCompositionEnd() {
    ac.onCompositionEnd(text);
  }

  function handleTextInput() {
    if (stt.showDiff) stt.clearDiff();
    ac.updateFromInput(text);
  }

  function handleSelectionChange() {
    if (ac.open) ac.updateFromInput(text);
  }

  // Programmatic focus is suppressed on mobile: auto-focusing pops the soft
  // keyboard without the user asking, covering half the screen. The user taps
  // the composer to focus instead. (User-initiated focus, e.g. tapping Edit,
  // goes through the exported focus() / direct calls and is unaffected.)
  function focusTextarea() {
    if (onMobile) return;
    if (messagesState.messages.length == 0 && textareaElement) {
      setTimeout(() => textareaElement?.focus(), 0);
    }
  }

  function focusInput() {
    if (onMobile) return;
    if (textareaElement) setTimeout(() => textareaElement?.focus(), 0);
  }

  $effect(() => {
    focusTextarea();
  });

  onMount(() => {
    const cleanups: Array<() => void> = [];

    // Input-mode shortcuts (attach/capture) are registered on the OS level via
    // tauri-plugin-global-shortcut, but only while:
    //   (1) UserInput is mounted (i.e. Settings panel is closed) AND
    //   (2) The window is currently visible.
    // (1) is satisfied for the lifetime of this component. (2) we track via the
    // `window-visibility` event below: register on visible=true, clear on
    // visible=false. Initial state is computed by registerIfVisible. The binding
    // computation + platform calls live in the inputShortcuts unit.

    // Focus the textarea on show, and (de)register input shortcuts in lockstep
    // with window visibility.
    void platform()
      .windowing.subscribeVisibility((visible) => {
        if (visible) {
          focusTextarea();
          void inputShortcuts.register();
        } else {
          void inputShortcuts.clear();
        }
      })
      .then((unsubscribe) => {
        cleanups.push(unsubscribe);
      });

    // Populate the monitor list for the always-visible screen-capture select.
    void composer.loadCaptureMonitors();

    void inputShortcuts
      .subscribeEvents({
        onAttachFile: () => {
          void composer.handleAttachFile();
        },
        onCaptureScreen: () => {
          // Pick the primary monitor from the composer's snapshot, falling back
          // to the first id we see. The list is populated lazily, so fetch it
          // if it's still empty.
          void (async () => {
            if (composer.captureMonitors.length === 0) await composer.loadCaptureMonitors();
            const monitors = composer.captureMonitors;
            const target = monitors.find((m) => m.isPrimary)?.id || monitors[0]?.id;
            if (target) await composer.captureMonitorById(target);
          })();
        },
        onCaptureRegion: () => {
          void composer.handleCaptureRegionFromMenu();
        },
      })
      .then((unsubscribe) => cleanups.push(unsubscribe));
    cleanups.push(() => {
      void inputShortcuts.clear();
    });

    // Initial registration: only if the window is already visible at mount time
    // (a hidden tray-only launch should not arm shortcuts).
    void inputShortcuts.registerIfVisible();

    // Async setup: monitors, VAD, shortcut listeners, persistent-mode restore.
    // Monitors are best-effort (benign on failure); VAD and shortcut setup
    // failures surface via the placeholder notice because DevTools aren't
    // available in the packaged app.
    void (async () => {
      try {
        try {
          const m = await platform().monitors.available();
          monitors = m.map((mon, i) => ({
            id: mon.id || i.toString(),
            name: mon.name || `Monitor ${i + 1}`,
            isPrimary: mon.isPrimary,
          }));
        } catch (err) {
          log.warn("Could not fetch monitors", err);
        }

        await vadManager.attach(handleVadAudio);

        const mode = settingsState.currentSettings["stt.activation"] as ActivationMode;
        if (
          mode === "sticky" &&
          settingsState.currentSettings["stt.vadPersistedState"] === true &&
          !vadManager.enabled
        ) {
          await vadManager.toggle();
        }
      } catch (err) {
        log.error("init failed:", err);
        showInputNotice("Voice input setup failed! Check the logs.", 8000);
      }
    })();

    return () => {
      for (const c of cleanups) c();
    };
  });

  onDestroy(() => {
    vadManager.detach();
    if (inputNoticeTimeout) {
      clearTimeout(inputNoticeTimeout);
      inputNoticeTimeout = null;
    }
  });

  function handleMonitorChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const monitorId = target.value;
    settingsState.updateSetting("layout.monitor", monitorId);
  }

  function handleAlignment(align: Alignment) {
    settingsState.updateSetting("layout.alignment", align);
  }

  async function handleStop(): Promise<void> {
    await streamingState.interruptStreaming();
  }

  async function handleInterruptAndSend(): Promise<void> {
    await streamingState.interruptStreaming();
    await handleSend();
  }

  async function handleSend() {
    // Block send while any work is in flight: stream OR active tool call.
    // Otherwise the user could queue a new LLM request while tools from a
    // prior turn are still executing / awaiting input.
    if (hasActiveWork) return;
    // Block send when the core WS isn't connected. Without this the message
    // optimistically lands in the local list and the chat.start frame is
    // dropped on the floor. The user sees a queued message that never streams.
    if (connectionState.state !== "connected") return;

    const trimmedText = text.trim();
    if (!trimmedText && composer.attachments.length === 0) return;

    stt.clearDiff();

    // Expand snippet triggers before the message leaves the input. The
    // resolved user text is what gets persisted + sent to the LLM; the
    // resolved effective system prompt (including any snippet-driven
    // prepend/replace/append) is attached to the user message so sendMessages
    // can pick it up verbatim.
    const { userText, systemOverride } = applySnippets(trimmedText, snippetsState.snippets);
    const effectiveSystemPrompt = applySystemPromptOverride(
      buildSystemPromptBase(),
      systemOverride,
      buildContextBlock(),
    );
    const systemPromptOverride =
      systemOverride && effectiveSystemPrompt ? effectiveSystemPrompt : undefined;

    const snapshot: Attachment[] = composer.attachments.map((a) => ({
      type: a.type,
      filename: a.filename,
      pendingData: a.pendingData,
      mime: a.mime,
    }));
    const timestamp = Date.now();

    text = "";
    composer.clear();
    ac.open = false;

    try {
      await messagesState.addUserMessage({
        text: userText,
        attachments: snapshot,
        timestamp,
        systemPromptOverride,
        effectiveSystemPrompt,
      });
      await sendMessages();
    } catch (err) {
      uiLog.error("sendMessages failed:", err);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (ac.handleKey(e, autocompleteOptions, applySnippetTrigger)) return;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!hasActiveWork) handleSend();
    }
  }

  async function handleVadAudio(audio: Float32Array) {
    await stt.handleVadAudio(audio, {
      getText: () => text,
      setText: (t) => {
        text = t;
      },
      focus: () => textareaElement?.focus(),
      // Auto-send interrupts any in-flight work first, mirroring the
      // interrupt-and-send button.
      onAutoSend: async () => {
        if (streamingState.hasActiveWork) {
          await streamingState.interruptStreaming();
        }
        await handleSend();
      },
      notice: (message) => showInputNotice(message),
    });
  }

  function handleBubbleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("button, select, textarea, a, input")) return;
    textareaElement?.focus();
  }

  // Voice button is idle/available when the speech sidecar is up (or disabled).
  let sttIdle = $derived(sttStatus === "Running" || sttStatus === "Disabled");
  let inPromptMode = $derived(!!permissionRequest || !!scheduleConfirm);
  let textareaDisabled = $derived(
    downloadsState.hasPending ||
      downloadsState.loading ||
      connectionState.reconnecting ||
      (llmStatus !== "Running" && llmStatus !== "Disabled"),
  );
</script>

<UserInputView
  baseColorOverride={themeOverrideHex}
  onBubbleClick={handleBubbleClick}
  bind:value={text}
  placeholder={placeholderText}
  {textareaDisabled}
  bind:textareaRef={textareaElement}
  bind:mirrorRef={mirrorSpan}
  onkeydown={handleKeydown}
  oninput={handleTextInput}
  onkeyup={handleSelectionChange}
  ontextareaclick={handleSelectionChange}
  oncompositionstart={handleCompositionStart}
  oncompositionend={handleCompositionEnd}
  ontextareablur={() => (ac.open = false)}
  onpaste={(e) => composer.handlePaste(e)}
  topSlot={autocorrectAlert}
  contentOverride={inPromptMode ? promptContent : undefined}
  belowContent={quickModelBar}
  attachmentSlot={attachmentRow}
  showLeftGroup={!inPromptMode}
  onAttach={() => composer.handleAttachFile()}
  onAttachImage={() => composer.handleAttachImageMobile()}
  captureMonitors={composer.captureMonitors}
  onCaptureSelect={(e) => composer.handleCaptureSelect(e)}
  capturing={composer.capturing}
  onCaptureRegion={() => composer.handleCaptureRegionFromMenu()}
  showImageCapture={!!settingsState.currentSettings["llm.supportImages"]}
  {monitors}
  selectedMonitor={settingsState.getMonitor()}
  onMonitorChange={handleMonitorChange}
  onAlign={(v) => handleAlignment(v)}
  settingsTitle={downloadsState.hasPending ? "Pending downloads - open settings" : "Settings"}
  {gearTone}
  onSettings={() => viewState.navigate("settings")}
  rightSlot={inPromptMode ? promptButtons : undefined}
  showTempToggle={sessionsState.storageEnabled && !sessionsState.started}
  tempActive={sessionsState.isTemporary}
  onTempToggle={() => sessionsState.toggleTemporary()}
  showVoice={!!settingsState.currentSettings["stt.enabled"]}
  voiceTitle={vadManager.enabled
    ? vadManager.listening
      ? "Listening..."
      : "VAD Active (click to disable)"
    : sttIdle
      ? "Enable Voice Input"
      : "Voice Input (Unavailable)"}
  voiceClass={vadManager.enabled
    ? vadManager.listening
      ? "text-accent-green-500"
      : "text-accent-blue-400"
    : sttIdle
      ? "text-default-700 hov:text-default-900"
      : "text-default-700"}
  voiceDisabled={vadManager.loading || (!sttIdle && !vadManager.enabled)}
  onVoiceToggle={() => vadManager.toggle()}
  pttHolding={shortcutHandler.pttHolding}
  pttHoldDuration={shortcutHandler.pttHoldDuration}
  vadEnabled={vadManager.enabled}
  vadListening={vadManager.listening}
  {sttIdle}
  {hasActiveWork}
  {hasContent}
  sendDisabled={connectionState.reconnecting}
  onSend={handleSend}
  onStop={handleStop}
  onInterruptAndSend={handleInterruptAndSend}
/>

{#snippet autocorrectAlert()}
  {#if stt.showDiff && stt.original !== null}
    <AutocorrectAlert
      original={stt.original}
      onReject={() => {
        if (stt.original !== null) text = stt.original;
        stt.clearDiff();
        textareaElement?.focus();
      }}
    />
  {/if}
{/snippet}

{#snippet promptContent()}
  {#if permissionRequest}
    <PermissionRequest request={permissionRequest} />
  {:else if scheduleConfirm && prompt.scheduleDraft}
    <ScheduleConfirmForm
      draft={prompt.scheduleDraft}
      onChange={(next) => (prompt.scheduleDraft = next)}
    />
  {/if}
{/snippet}

{#snippet quickModelBar()}
  <QuickModelBar />
{/snippet}

{#snippet attachmentRow()}
  <AttachmentList
    parts={attachmentParts}
    editable
    onRemove={(i) => composer.removeAttachment(i)}
    onImageClick={(url) => composer.openImagePreview(url)}
  />
{/snippet}

{#snippet promptButtons()}
  {#if permissionRequest}
    <PromptButtonsView
      buttons={[
        {
          icon: "i-material-symbols-close-rounded",
          label: "Deny",
          title: "Reject this permission request",
          onClick: () => permissionState.respond(false),
        },
        {
          icon: "i-material-symbols-check-rounded",
          label: "Allow",
          title: "Allow for this tool call",
          onClick: () => permissionState.respond(true),
        },
      ]}
    />
  {:else if scheduleConfirm}
    <PromptButtonsView
      buttons={[
        {
          icon: "i-material-symbols-close-rounded",
          label: "Decline",
          title: "Decline this scheduled prompt",
          onClick: () => prompt.respondScheduleConfirm(false),
        },
        {
          icon: "i-material-symbols-check-rounded",
          label: "Save",
          title: "Save the scheduled prompt",
          disabled: !prompt.scheduleDraftReady,
          onClick: () => prompt.respondScheduleConfirm(true),
        },
      ]}
    />
  {/if}
{/snippet}

<svelte:window onblur={() => composer.closeImagePreview()} />

{#if ac.open}
  <div style:display="contents" style:--default-base={themeOverrideHex}>
    <SnippetAutocomplete
      options={autocompleteOptions}
      selectedIndex={ac.index}
      anchor={ac.anchor}
      onSelect={applySnippetTrigger}
    />
  </div>
{/if}

{#if composer.previewImageUrl}
  <Modal
    open
    onclose={() => composer.closeImagePreview()}
    positioning="fixed"
    surface="transparent"
    maxWidth="fit"
    ariaLabel="Image preview"
  >
    <img
      src={composer.previewImageUrl}
      alt="Preview"
      class="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-6rem)] object-contain rounded-medium shadow-2xl"
    />
  </Modal>
{/if}
