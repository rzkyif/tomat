<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type {
    Alignment,
    Monitor,
    Attachment,
    MessagePart,
  } from "$lib/shared/types";
  import { platform } from "$lib/platform";
  import {
    downloadsState,
    messagesState,
    permissionState,
    scheduleConfirmState,
    documentsState,
    serversState,
    settingsState,
    snippetsState,
    streamingState,
    viewState,
  } from "../../state";
  import type { ScheduledPromptDraft } from "@tomat/shared";
  import { connectionState } from "$lib/state/connection.svelte";
  import { getLogger } from "$lib/shared/log";

  const log = getLogger("user-input");
  const attachLog = getLogger("attach");
  const uiLog = getLogger("ui");

  async function sendMessages(_anchorUserId?: string): Promise<void> {
    // Trigger the server-side chat turn. The streaming state subscribes
    // to chat.* frames and mutates the message list as content arrives.
    streamingState.beginTurn(_anchorUserId ?? null);
    streamingState.start();
  }

  // Edit / reprocess flows in messagesState regenerate a turn by calling
  // back into this dispatch (see the handler note in messages.svelte.ts).
  messagesState.setLLMHandlers(sendMessages);

  import {
    classifyAttachment,
    DOC_EXTENSIONS,
    IMAGE_EXTENSIONS,
    ingestDocumentBlob,
    ingestDocumentFromPath,
    ingestImageBlob,
    MIME_BY_EXT,
  } from "$lib/shared/attachments";
  import { applySnippets } from "$lib/shared/snippets";
  import {
    type AutocompleteOption,
    collectExistingTriggers,
    useAutocomplete,
  } from "$lib/composables/use-autocomplete.svelte";
  import { useStt } from "$lib/composables/use-stt-input.svelte";
  import { documentTrigger } from "$lib/state/documents.svelte";
  import {
    applySystemPromptOverride,
    buildContextBlock,
    buildSystemPromptBase,
  } from "$lib/shared/system-prompt";
  import SnippetAutocomplete from "./SnippetAutocomplete.svelte";
  import {
    pauseClickThrough,
    resumeClickThrough,
  } from "$lib/shared/clickthrough";
  import {
    listCaptureMonitors,
    captureMonitor,
    captureRegion,
    type CaptureMonitorInfo,
  } from "$lib/shared/capture";
  import { vadManager } from "$lib/state/vad.svelte";
  import { shortcutHandler } from "$lib/state/shortcut.svelte";
  import { useBlink } from "$lib/composables/use-blink.svelte";
  import type { ActivationMode } from "@tomat/shared";
  import AttachmentList from "./AttachmentList.svelte";
  import AutocorrectAlert from "./userinput/AutocorrectAlert.svelte";
  import PermissionRequest from "./userinput/PermissionRequest.svelte";
  import ScheduleConfirmForm from "./userinput/ScheduleConfirmForm.svelte";
  import Bubble from "../ui/Bubble.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Modal from "../ui/Modal.svelte";
  import { hasAlpha } from "$lib/shared/color";

  const themeOverride = $derived(
    settingsState.currentSettings[
      "appearance.userInputDefaultColor"
    ] as string,
  );
  const themeOverrideHex = $derived(
    hasAlpha(themeOverride) ? themeOverride : null,
  );

  let text = $state("");
  let monitors: Monitor[] = $state([]);
  let textareaElement: HTMLTextAreaElement | undefined = $state();
  let mirrorSpan: HTMLSpanElement | undefined = $state();
  let attachments = $state<Attachment[]>([]);

  // The `@trigger` autocomplete dropdown and the speech-to-text pipeline are
  // each their own stateful unit; this component owns the lifecycle wiring (see
  // onMount / the effects below) and the option list, which spans two stores.
  const ac = useAutocomplete();
  ac.bind(() => textareaElement, () => mirrorSpan);
  const stt = useStt();

  let autocompleteOptions = $derived.by<AutocompleteOption[]>(() => {
    if (!ac.open) return [];
    const prefix = ac.prefix.toLowerCase();
    const existing = collectExistingTriggers(
      text,
      ac.triggerStart,
      ac.triggerEnd,
    );
    const snippets = snippetsState.snippets
      .filter((s) => {
        if (!s.trigger.toLowerCase().startsWith(prefix)) return false;
        // insert-user snippets are explicitly designed to be dropped inline
        // multiple times, so don't filter them out even if already present.
        if (
          s.placement !== "insert-user" &&
          existing.has(s.trigger.toLowerCase())
        ) {
          return false;
        }
        return true;
      })
      .map<AutocompleteOption>((s) => ({
        id: `snippet:${s.id}`,
        name: s.name,
        trigger: s.trigger,
        source: "snippet",
      }));
    const snippetTriggers = new Set(
      snippetsState.snippets.map((s) => s.trigger.toLowerCase()),
    );
    const documents = documentsState.documents
      .map((d) => ({ doc: d, trigger: documentTrigger(d) }))
      .filter(
        ({ trigger }) =>
          trigger.toLowerCase().startsWith(prefix) &&
          !existing.has(trigger.toLowerCase()) &&
          !snippetTriggers.has(trigger.toLowerCase()),
      )
      .sort((a, b) => a.trigger.localeCompare(b.trigger))
      .map<AutocompleteOption>(({ doc, trigger }) => ({
        id: `document:${doc.id}`,
        name: doc.title,
        trigger,
        source: "document",
      }));
    return [...snippets, ...documents];
  });

  $effect(() => {
    ac.clampIndex(autocompleteOptions.length);
  });

  let captureMonitors = $state<CaptureMonitorInfo[]>([]);
  let capturing = $state(false);

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
  // call only ("always allow" lives in the Toolkit detail view).
  let permissionRequest = $derived(permissionState.pending);

  // Schedule-confirm mode: a running tool proposed a scheduled prompt and is
  // paused on this editable form. Mirrors the permission mode: the textarea
  // is replaced by the form, attach/voice/send controls hide, X and check
  // buttons decide. The user's edits ride back on the accept.
  let scheduleConfirm = $derived(scheduleConfirmState.pending);
  let scheduleDraft = $state<ScheduledPromptDraft | null>(null);
  $effect(() => {
    // The pending frame is reactive deep state, so its draft is a Proxy;
    // structuredClone would throw DataCloneError on it. $state.snapshot
    // returns a plain editable clone (the same call the accept path uses).
    scheduleDraft = scheduleConfirm ? $state.snapshot(scheduleConfirm.draft) : null;
  });
  let scheduleDraftReady = $derived.by(() => {
    const d = scheduleDraft;
    if (!d) return false;
    if (!d.title.trim() || !d.instruction.trim()) return false;
    // A "once" in the past would never fire; make the user pick a future time.
    if (d.schedule.kind === "once" && d.schedule.atMs <= Date.now()) return false;
    return true;
  });
  function respondScheduleConfirm(accepted: boolean): void {
    const draft = scheduleDraft;
    scheduleConfirmState.respond(
      accepted,
      accepted && draft ? $state.snapshot(draft) : undefined,
    );
  }

  let hasContent = $derived(text.trim().length > 0 || attachments.length > 0);

  let placeholderText = $derived(
    inputNotice
      ? inputNotice
      : connectionState.reconnecting
      ? "Reconnecting to core..."
      : downloadsState.hasPending
      ? "Pending download, open settings!"
      : downloadsState.loading
        ? "Connecting to core..."
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
    attachments.map((att): MessagePart => {
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

  let previewImageUrl = $state<string | null>(null);

  function openImagePreview(url: string) {
    if (url) previewImageUrl = url;
  }

  function closeImagePreview() {
    previewImageUrl = null;
  }

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

  function focusTextarea() {
    if (messagesState.messages.length == 0 && textareaElement) {
      setTimeout(() => textareaElement?.focus(), 0);
    }
  }

  function focusInput() {
    if (textareaElement) setTimeout(() => textareaElement?.focus(), 0);
  }

  $effect(() => {
    focusTextarea();
  });

  onMount(() => {
    const cleanups: Array<() => void> = [];

    // Input-mode shortcuts are registered on the OS level via
    // tauri-plugin-global-shortcut, but only while:
    //   (1) UserInput is mounted (i.e. Settings panel is closed) AND
    //   (2) The window is currently visible.
    // (1) is satisfied for the lifetime of this component. (2) we track via
    // the `window-visibility` event: register on visible=true, clear on
    // visible=false. Initial state is computed inside the async setup below.
    function readInputBindings(): [string, string][] {
      const s = settingsState.currentSettings;
      return [
        ["attach-file", (s["shortcuts.attachFile"] as string) || ""],
        ["capture-screen", (s["shortcuts.captureScreen"] as string) || ""],
        ["capture-region", (s["shortcuts.captureRegion"] as string) || ""],
      ];
    }
    async function registerInputShortcuts() {
      try {
        await platform().shortcuts.setInputBindings(readInputBindings());
      } catch (e) {
        log.warn("set_input_shortcuts failed:", e);
      }
    }
    async function clearInputShortcuts() {
      try {
        await platform().shortcuts.setInputBindings([]);
      } catch (e) {
        log.warn("clear input_shortcuts failed:", e);
      }
    }

    // Focus the textarea on show, and (de)register input shortcuts in lockstep
    // with window visibility.
    void platform()
      .windowing.subscribeVisibility((visible) => {
        if (visible) {
          focusTextarea();
          void registerInputShortcuts();
        } else {
          void clearInputShortcuts();
        }
      })
      .then((unsubscribe) => {
        cleanups.push(unsubscribe);
      });

    // Populate the monitor list for the always-visible screen-capture select.
    void listCaptureMonitors().then((m) => {
      captureMonitors = m;
    });

    void platform()
      .shortcuts.subscribeInputEvents({
        onAttachFile: () => {
          void handleAttachFileFromMenu();
        },
        onCaptureScreen: () => {
          // Pick the primary monitor from the captureMonitors snapshot,
          // falling back to the first id we see. captureMonitors is
          // populated lazily via the attach-menu open path; if it's empty
          // we still try to fetch.
          void (async () => {
            let monitors = captureMonitors;
            if (monitors.length === 0) {
              monitors = await listCaptureMonitors();
              captureMonitors = monitors;
            }
            const target = monitors.find((m) => m.isPrimary)?.id || monitors[0]?.id;
            if (target) await captureMonitorById(target);
          })();
        },
        onCaptureRegion: () => {
          void handleCaptureRegionFromMenu();
        },
      })
      .then((unsubscribe) => cleanups.push(unsubscribe));
    cleanups.push(() => {
      void clearInputShortcuts();
    });

    // Initial registration: only if the window is already visible at mount
    // time. Most of the time it is (closing Settings doesn't hide the window),
    // but on app startup with a hidden tray-only launch we'd otherwise
    // register shortcuts that should be inactive.
    void (async () => {
      try {
        const visible = await platform().windowing.isVisible();
        if (visible) await registerInputShortcuts();
      } catch (e) {
        log.warn("initial visibility check failed:", e);
      }
    })();

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

        const mode = settingsState.currentSettings[
          "stt.activation"
        ] as ActivationMode;
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
    if (!trimmedText && attachments.length === 0) return;

    stt.clearDiff();

    // Expand snippet triggers before the message leaves the input. The
    // resolved user text is what gets persisted + sent to the LLM; the
    // resolved effective system prompt (including any snippet-driven
    // prepend/replace/append) is attached to the user message so sendMessages
    // can pick it up verbatim.
    const { userText, systemOverride } = applySnippets(
      trimmedText,
      snippetsState.snippets,
    );
    const effectiveSystemPrompt = applySystemPromptOverride(
      buildSystemPromptBase(),
      systemOverride,
      buildContextBlock(),
    );
    const systemPromptOverride =
      systemOverride && effectiveSystemPrompt
        ? effectiveSystemPrompt
        : undefined;

    const snapshot: Attachment[] = attachments.map((a) => ({
      type: a.type,
      filename: a.filename,
      pendingData: a.pendingData,
      mime: a.mime,
    }));
    const timestamp = Date.now();

    text = "";
    attachments = [];
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

  async function handlePaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length === 0) return;

    const supportsImages = !!settingsState.currentSettings["llm.supportImages"];
    let handledAny = false;

    for (const file of files) {
      const name = file.name || "pasted";
      const kind = classifyAttachment(name, file.type, supportsImages);
      if (!kind) continue;

      handledAny = true;
      try {
        if (kind.kind === "image") {
          const baseName = name.includes(".") ? name : `${name}.${kind.ext}`;
          attachments = [
            ...attachments,
            await ingestImageBlob(file, baseName, kind.ext),
          ];
        } else {
          attachments = [...attachments, await ingestDocumentBlob(file, name)];
        }
      } catch (err) {
        attachLog.error("Paste ingestion failed:", err);
      }
    }

    if (handledAny) e.preventDefault();
  }

  async function handleAttachFile() {
    try {
      const supportsImages = settingsState.currentSettings["llm.supportImages"];

      const filters = [
        {
          name: "Documents",
          extensions: DOC_EXTENSIONS,
        },
      ];

      if (supportsImages) {
        filters.push({
          name: "Images",
          extensions: IMAGE_EXTENSIONS,
        });
      }

      // Shrink window and center Y to prevent macOS dimming overlay on
      // transparent window while the native file picker is open.
      const win = platform().windowing;
      const savedSize = await win.outerSize();
      const savedPos = await win.outerPosition();
      const monitor = await win.currentMonitor();
      const centerX = Math.round(savedPos.x + savedSize.width / 2);
      const centerY = monitor
        ? Math.round(monitor.y + monitor.height / 3)
        : savedPos.y;
      await pauseClickThrough();
      await win.setOuterSize({ width: 1, height: 1 });
      await win.setOuterPosition({ x: centerX, y: centerY });

      let picked: string[];
      try {
        picked = await platform().dialog.openFilePicker({
          multiple: false,
          filters,
        });
      } finally {
        await win.setOuterPosition({ x: savedPos.x, y: savedPos.y });
        await win.setOuterSize({ width: savedSize.width, height: savedSize.height });
        await resumeClickThrough();
      }

      if (picked.length === 0) return;
      const filePath = picked[0];
      const fileName =
        filePath.split("/").pop() || filePath.split("\\").pop() || "file";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";

      if (IMAGE_EXTENSIONS.includes(ext)) {
        const data = await platform().fs.readFile(filePath);
        const mime = MIME_BY_EXT[ext] || "image/png";
        // .slice() returns a Uint8Array backed by a fresh non-shared
        // ArrayBuffer, which Blob's `BlobPart` signature requires.
        const blob = new Blob([data.slice().buffer], { type: mime });
        attachments = [...attachments, await ingestImageBlob(blob, fileName, ext)];
      } else {
        attachments = [
          ...attachments,
          await ingestDocumentFromPath(filePath, fileName),
        ];
      }
      focusInput();
    } catch (err) {
      attachLog.error("File attach failed:", err);
    }
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index);
  }

  async function handleAttachFileFromMenu() {
    await handleAttachFile();
  }

  function handleCaptureSelect(e: Event) {
    const target = e.target as HTMLSelectElement;
    const id = target.value;
    target.value = "";
    if (id) void captureMonitorById(id);
  }

  async function captureMonitorById(monitorId: string) {
    if (capturing) return;
    capturing = true;
    try {
      const base64 = await captureMonitor(monitorId);
      if (base64) {
        attachments = [
          ...attachments,
          {
            type: "image",
            filename: `screenshot-${Date.now()}.png`,
            pendingData: base64,
            mime: "image/png",
          },
        ];
        focusInput();
      }
    } finally {
      capturing = false;
    }
  }

  async function handleCaptureRegionFromMenu() {
    if (capturing) return;
    capturing = true;
    try {
      const base64 = await captureRegion();
      if (base64) {
        attachments = [
          ...attachments,
          {
            type: "image",
            filename: `region-${Date.now()}.png`,
            pendingData: base64,
            mime: "image/png",
          },
        ];
        focusInput();
      }
    } finally {
      capturing = false;
    }
  }

  function handleBubbleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("button, select, textarea, a, input")) return;
    textareaElement?.focus();
  }

  const ALIGNMENTS = [
    {
      value: "left",
      icon: "i-material-symbols-format-align-left-rounded",
      title: "Align Left",
    },
    {
      value: "center",
      icon: "i-material-symbols-format-align-center-rounded",
      title: "Align Center",
    },
    {
      value: "right",
      icon: "i-material-symbols-format-align-right-rounded",
      title: "Align Right",
    },
  ] as const;
</script>

<div style:display="contents" style:--default-base={themeOverrideHex}>
<Bubble
  selectedAlignment={settingsState.getAlignment()}
  extraClass="flex flex-col gap-4 min-w-0 overflow-hidden transition-all"
  onclick={handleBubbleClick}
>
  <!-- LLM autocorrect before -->
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

  {#if permissionRequest}
    <PermissionRequest request={permissionRequest} />
  {:else if scheduleConfirm && scheduleDraft}
    <ScheduleConfirmForm
      draft={scheduleDraft}
      onChange={(next) => (scheduleDraft = next)}
    />
  {:else}
  <div class="grid w-fit min-w-0 max-w-[calc(100vw-135px)] overflow-clip">
    <!-- Hidden span for the typed text to dynamically expand width and height. Safely renders newlines.
         Doubles as a layout mirror for the autocomplete caret measurement. -->
    <span
      bind:this={mirrorSpan}
      class="invisible whitespace-pre-wrap break-words wrap-break-word col-start-1 row-start-1 pointer-events-none"
      >{text ? text + "\u200b" : placeholderText}</span
    >
    <textarea
      aria-label="Message input"
      bind:this={textareaElement}
      bind:value={text}
      onkeydown={handleKeydown}
      oninput={handleTextInput}
      onkeyup={handleSelectionChange}
      onclick={handleSelectionChange}
      oncompositionstart={handleCompositionStart}
      oncompositionend={handleCompositionEnd}
      onblur={() => (ac.open = false)}
      onpaste={handlePaste}
      autocapitalize="on"
      autocomplete="off"
      rows="1"
      cols="1"
      class="col-start-1 row-start-1 bg-transparent outline-none min-w-0 w-full max-w-[calc(100vw-80px)] max-w-full overflow-hidden resize-none whitespace-pre-wrap break-words"
      placeholder={placeholderText}
      disabled={downloadsState.hasPending ||
        downloadsState.loading ||
        connectionState.reconnecting ||
        (llmStatus !== "Running" && llmStatus !== "Disabled")}
    ></textarea>
  </div>
  {/if}

  <!-- Attachment previews -->
  <AttachmentList
    parts={attachmentParts}
    editable
    onRemove={removeAttachment}
    onImageClick={openImagePreview}
  />

  <div
    class="flex items-end justify-between gap-2 text-2xl text-default-700 w-full"
  >
    {#if !permissionRequest && !scheduleConfirm}
    <div class="flex items-center bg-surface-inset rounded-large p-1">
      <IconButton
        icon="i-material-symbols-attach-file-rounded"
        title="Attach File"
        size="lg-tight"
        onclick={handleAttachFileFromMenu}
      />

      <!-- Screen capture: an icon with an overlaid monitor <select>. A <select>
           can't live inside a <button>, so this matches IconButton's lg-tight
           sizing (p-1 text-xl) by hand instead of using the component. -->
      <div
        class="relative flex items-center justify-center shrink-0 p-1 text-xl text-default-700 hover:text-default-900 rounded transition-colors"
      >
        <i class="flex i-material-symbols-screenshot-monitor-outline-rounded"
        ></i>
        <select
          class="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base"
          title="Screen Capture"
          aria-label="Screen Capture Monitor"
          onchange={handleCaptureSelect}
          disabled={capturing}
          value=""
        >
          <option value="" disabled>Select Monitor</option>
          {#each captureMonitors as mon}
            <option value={mon.id}
              >{mon.name}{mon.isPrimary ? " (Primary)" : ""}</option
            >
          {/each}
        </select>
      </div>

      <IconButton
        icon="i-material-symbols-crop-free-rounded"
        title="Capture Region"
        ariaLabel="Capture Screen Region"
        size="lg-tight"
        disabled={capturing}
        onclick={handleCaptureRegionFromMenu}
      />
    </div>
    {/if}

    <div class="flex items-center bg-surface-inset rounded-large p-1">
      <div
        class="relative flex items-center justify-center shrink-0 p-1 text-xl text-default-700 hover:text-default-900 rounded transition-colors"
      >
        <i class="flex i-material-symbols-desktop-windows-outline-rounded"></i>
        <select
          class="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base"
          onchange={handleMonitorChange}
          value={settingsState.getMonitor()}
        >
          <option value="primary">Primary Monitor</option>
          {#each monitors as monitor}
            <option value={monitor.id}>{monitor.name}</option>
          {/each}
        </select>
      </div>

      <div class="flex items-center">
        {#each ALIGNMENTS as align}
          <IconButton
            icon={align.icon}
            title={align.title}
            size="lg-tight"
            onclick={() => handleAlignment(align.value)}
          />
        {/each}
      </div>

      <IconButton
        icon="i-material-symbols-settings-outline-rounded"
        title={downloadsState.hasPending
          ? "Pending downloads - open settings"
          : "Settings"}
        colorClass={gearTone}
        size="lg-tight"
        onclick={() => viewState.navigate("settings")}
        class="transition-colors duration-500"
      />
    </div>

    <div class="flex gap-2">
      {#if permissionRequest}
        <!-- Icon + text on the filled inset surface (rounded-large), neutral
             text like the other UserInput buttons, and the h-9 height of the
             monitor/alignment/settings pill beside them. -->
        <button
          type="button"
          title="Reject this permission request"
          class="flex items-center gap-1.5 h-9 px-3 shrink-0 rounded-large bg-surface-inset text-sm font-medium text-default-700 hover:text-default-900 hover:cursor-pointer transition-colors"
          onclick={() => permissionState.respond(false)}
        >
          <i class="flex i-material-symbols-close-rounded text-lg shrink-0"></i>
          Deny
        </button>
        <button
          type="button"
          title="Allow for this tool call"
          class="flex items-center gap-1.5 h-9 px-3 shrink-0 rounded-large bg-surface-inset text-sm font-medium text-default-700 hover:text-default-900 hover:cursor-pointer transition-colors"
          onclick={() => permissionState.respond(true)}
        >
          <i class="flex i-material-symbols-check-rounded text-lg shrink-0"></i>
          Allow
        </button>
      {:else if scheduleConfirm}
        <button
          type="button"
          title="Decline this scheduled prompt"
          class="flex items-center gap-1.5 h-9 px-3 shrink-0 rounded-large bg-surface-inset text-sm font-medium text-default-700 hover:text-default-900 hover:cursor-pointer transition-colors"
          onclick={() => respondScheduleConfirm(false)}
        >
          <i class="flex i-material-symbols-close-rounded text-lg shrink-0"></i>
          Decline
        </button>
        <button
          type="button"
          title="Save the scheduled prompt"
          disabled={!scheduleDraftReady}
          class="flex items-center gap-1.5 h-9 px-3 shrink-0 rounded-large bg-surface-inset text-sm font-medium text-default-700 hover:text-default-900 hover:cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onclick={() => respondScheduleConfirm(true)}
        >
          <i class="flex i-material-symbols-check-rounded text-lg shrink-0"></i>
          Save
        </button>
      {:else}
      {#if settingsState.currentSettings["stt.enabled"]}
        {@const sttIdle =
          sttStatus === "Running" || sttStatus === "Disabled"}
        <IconButton
          size="lg"
          surface="filled"
          title={vadManager.enabled
            ? vadManager.listening
              ? "Listening..."
              : "VAD Active (click to disable)"
            : sttIdle
              ? "Enable Voice Input"
              : "Voice Input (Unavailable)"}
          class="rounded-large {vadManager.enabled
            ? vadManager.listening
              ? 'text-green-500'
              : 'text-blue-400'
            : sttIdle
              ? 'text-default-700 hover:text-default-900'
              : 'cursor-not-allowed'}"
          disabled={vadManager.loading ||
            (!sttIdle && !vadManager.enabled)}
          onclick={() => vadManager.toggle()}
        >
          {#snippet icon()}
            {#if shortcutHandler.pttHolding}
              <svg
                class="ptt-ring flex w-[1em] h-[1em] text-default-700"
                style="--ptt-duration: {shortcutHandler.pttHoldDuration}ms"
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
                class="flex {vadManager.enabled
                  ? vadManager.listening
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
        class="rounded-large {hasActiveWork && !hasContent
          ? 'text-red-500 hover:text-red-400'
          : ''}"
        disabled={connectionState.reconnecting}
        onclick={hasActiveWork && !hasContent
          ? handleStop
          : hasActiveWork && hasContent
            ? handleInterruptAndSend
            : handleSend}
      />
      {/if}
    </div>
  </div>
</Bubble>
</div>

<svelte:window onblur={closeImagePreview} />

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

{#if previewImageUrl}
  <Modal
    open
    onclose={closeImagePreview}
    positioning="fixed"
    surface="transparent"
    maxWidth="fit"
    ariaLabel="Image preview"
  >
    <img
      src={previewImageUrl}
      alt="Preview"
      class="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-6rem)] object-contain rounded-medium shadow-2xl"
    />
  </Modal>
{/if}

<style>
  /* Push-to-talk hold ring: starts at 0% on press and fills to 100% over the
     configured hold duration. The SVG is mounted only while the shortcut is
     held, so the keyframes always run from the start; release-before-fill
     simply unmounts the element. `pathLength="100"` lets the dasharray math
     stay in percent regardless of the circle's actual circumference. */
  .ptt-ring circle {
    animation: ptt-ring-fill var(--ptt-duration) linear forwards;
  }
  @keyframes ptt-ring-fill {
    to {
      stroke-dashoffset: 0;
    }
  }

</style>
