<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type {
    Alignment,
    Monitor,
    Attachment,
    MessagePart,
  } from "$lib/shared/types";
  import {
    availableMonitors,
    currentMonitor,
    getCurrentWindow,
  } from "@tauri-apps/api/window";
  import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
  import { tempDir, join } from "@tauri-apps/api/path";
  import { readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    downloadsState,
    messagesState,
    serversState,
    settingsState,
    snippetsState,
    streamingState,
  } from "../../state";
  import { cores } from "$lib/core";
  import { connectionState } from "$lib/state/connection.svelte";

  // The old $lib/sidecar/llm and $lib/sidecar/stt modules are gone; their
  // functionality now lives server-side. The shims below preserve the
  // existing call sites so this component compiles; the deeper
  // autocorrect/merge UX needs a follow-up pass to wire to a new core
  // endpoint or implement client-side post-processing.

  async function sendMessages(_anchorUserId?: string): Promise<void> {
    // Trigger the server-side chat turn. The streaming state subscribes
    // to chat.* frames and mutates the message list as content arrives.
    streamingState.beginTurn(_anchorUserId ?? null);
    streamingState.start();
  }

  async function transcribeAudio(
    audio: Blob | string,
    language?: string,
  ): Promise<{ text: string; error?: string }> {
    try {
      // The legacy call site sometimes passes a base64 string; rehydrate to
      // a Blob for the multipart upload.
      const blob = typeof audio === "string"
        ? new Blob([Uint8Array.from(atob(audio), (c) => c.charCodeAt(0))], { type: "audio/wav" })
        : audio;
      const res = await cores().api().stt.transcribe(blob, language);
      return { text: res.text };
    } catch (e) {
      return { text: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function autocorrectTranscription(text: string): Promise<string> {
    return cores().api().llm.autocorrect(text);
  }

  async function mergeTranscription(prior: string, next: string): Promise<string> {
    return cores().api().llm.merge(prior, next);
  }
  import { float32ToWav, blobToBase64 } from "$lib/shared/audio";
  import {
    applySnippets,
    TRIGGER_BEFORE_CARET,
    type Snippet,
  } from "$lib/shared/snippets";
  import {
    applySystemPromptOverride,
    buildContextBlock,
    buildSystemPromptBase,
  } from "$lib/shared/systemPrompt";
  import SnippetAutocomplete from "./SnippetAutocomplete.svelte";
  import {
    pauseClickThrough,
    resumeClickThrough,
  } from "$lib/shared/clickthrough";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import {
    listCaptureMonitors,
    captureMonitor,
    captureRegion,
    type CaptureMonitorInfo,
  } from "$lib/shared/capture";
  import { vadManager } from "$lib/state/vad.svelte";
  import { shortcutHandler } from "$lib/state/shortcut.svelte";
  import type { ActivationMode } from "@tomat/shared";
  import AttachmentList from "../AttachmentList.svelte";
  import Bubble from "../Bubble.svelte";
  import { hasAlpha } from "$lib/shared/color";

  const themeOverride = $derived(
    settingsState.currentSettings[
      "appearance.userInputDefaultColor"
    ] as string,
  );
  const themeOverrideHex = $derived(
    hasAlpha(themeOverride) ? themeOverride : null,
  );

  let { toggleSettings, showSettings } = $props<{
    toggleSettings: () => void;
    showSettings: boolean;
  }>();

  let text = $state("");
  let monitors: Monitor[] = $state([]);
  let textareaElement: HTMLTextAreaElement | undefined = $state();
  let mirrorSpan: HTMLSpanElement | undefined = $state();
  let attachments = $state<Attachment[]>([]);
  let originalTranscription = $state<string | null>(null);
  let showAutocorrectDiff = $state(false);

  let autocompleteOpen = $state(false);
  let autocompletePrefix = $state("");
  let autocompleteIndex = $state(0);
  let autocompleteAnchor = $state({ top: 0, left: 0 });
  let autocompleteTriggerStart = $state(-1);
  let autocompleteTriggerEnd = $state(-1);
  let imeComposing = $state(false);

  /** Collects every `@trigger` token already present in `text`, excluding the
   *  token currently being typed (so the one you're filtering on doesn't
   *  filter itself out). Used to hide already-applied single-shot snippets
   *  from autocomplete suggestions. */
  function collectExistingTriggers(
    source: string,
    excludeStart: number,
    excludeEnd: number,
  ): Set<string> {
    const found = new Set<string>();
    const re = /(^|[^\w@])(@[A-Za-z0-9_-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const tokenStart = match.index + match[1].length;
      const tokenEnd = tokenStart + match[2].length;
      if (tokenEnd <= excludeStart || tokenStart >= excludeEnd) {
        found.add(match[2].toLowerCase());
      }
    }
    return found;
  }

  let autocompleteOptions = $derived.by<Snippet[]>(() => {
    if (!autocompleteOpen) return [];
    const prefix = autocompletePrefix.toLowerCase();
    const existing = collectExistingTriggers(
      text,
      autocompleteTriggerStart,
      autocompleteTriggerEnd,
    );
    return snippetsState.snippets.filter((s) => {
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
    });
  });

  $effect(() => {
    if (!autocompleteOpen) return;
    if (autocompleteOptions.length === 0) {
      autocompleteOpen = false;
      return;
    }
    if (autocompleteIndex >= autocompleteOptions.length) {
      autocompleteIndex = 0;
    }
  });

  let attachMenuOpen = $state(false);
  let captureMonitors = $state<CaptureMonitorInfo[]>([]);
  let capturing = $state(false);

  let sttError = $state<string | null>(null);
  let sttErrorTimeout: ReturnType<typeof setTimeout> | null = null;

  let llmStatus = $derived(serversState.serverStatuses.llama.status);

  // Drives the gear-icon flash while there are pending startup downloads
  // and Settings is closed. We toggle the bool on a 500ms interval so the
  // button can swap between its default and hover color tokens with a
  // smooth transition-colors tween (CSS keyframes against design tokens
  // would have to hardcode oklch values and re-state dark-mode variants).
  let pendingBlinkOn = $state(false);
  $effect(() => {
    if (!downloadsState.hasPendingStartup || showSettings) {
      pendingBlinkOn = false;
      return;
    }
    const id = setInterval(() => {
      pendingBlinkOn = !pendingBlinkOn;
    }, 500);
    return () => clearInterval(id);
  });
  // True whenever the user has something to interrupt: either an LLM stream
  // or an active tool call (running or awaiting input). Drives the stop button
  // so tool calls can be aborted the same way streams are.
  let hasActiveWork = $derived(streamingState.hasActiveWork);
  let hasContent = $derived(text.trim().length > 0 || attachments.length > 0);
  let placeholderText = $derived(
    downloadsState.hasPendingStartup
      ? "Pending download, open settings!"
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
  let sttStatus = $derived(serversState.serverStatuses.whisper.status);

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

  function handlePreviewKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") closeImagePreview();
  }

  // Anchors the autocomplete dropdown under the caret by measuring a Range on
  // the sibling sizing span. It shares the textarea's grid cell and wraps
  // identically, so we can read the caret position directly without cloning
  // styles into a hidden mirror.
  function measureCaretAt(index: number): { top: number; left: number } {
    if (!mirrorSpan || !textareaElement) return { top: 0, left: 0 };
    const textNode = mirrorSpan.firstChild;
    if (!textNode) return { top: 0, left: 0 };
    const range = document.createRange();
    const safeIndex = Math.min(index, textNode.textContent?.length ?? 0);
    range.setStart(textNode, safeIndex);
    range.setEnd(textNode, safeIndex);
    const rect = range.getBoundingClientRect();
    const cs = window.getComputedStyle(textareaElement);
    const lineHeight =
      parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    return { top: rect.top + lineHeight + 4, left: rect.left };
  }

  function updateAutocompleteFromInput() {
    if (imeComposing || !textareaElement) {
      autocompleteOpen = false;
      return;
    }
    const ta = textareaElement;
    const caret = ta.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const match = before.match(TRIGGER_BEFORE_CARET);
    if (!match) {
      autocompleteOpen = false;
      return;
    }
    const token = match[1];
    // Only reset the selected index when the filter prefix actually changed
    // (or we're freshly opening). Otherwise arrow-key presses, which fire
    // onkeyup -> here, would bounce the highlight back to the first option.
    const prefixChanged = !autocompleteOpen || token !== autocompletePrefix;
    autocompletePrefix = token;
    autocompleteTriggerStart = caret - token.length;
    autocompleteTriggerEnd = caret;
    if (prefixChanged) {
      autocompleteIndex = 0;
    }
    autocompleteAnchor = measureCaretAt(autocompleteTriggerStart);
    autocompleteOpen = true;
  }

  function applySnippetTrigger(snippet: Snippet) {
    if (!textareaElement) return;
    const ta = textareaElement;
    const start = autocompleteTriggerStart;
    const end = autocompleteTriggerEnd;
    if (start < 0 || end < 0) {
      autocompleteOpen = false;
      return;
    }
    const before = text.slice(0, start);
    const after = text.slice(end);
    const replacement = `${snippet.trigger} `;
    text = `${before}${replacement}${after}`;
    autocompleteOpen = false;
    const newCaret = start + replacement.length;
    // Restore caret position after Svelte updates the DOM value.
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
  }

  function handleCompositionStart() {
    imeComposing = true;
    autocompleteOpen = false;
  }

  function handleCompositionEnd() {
    imeComposing = false;
    updateAutocompleteFromInput();
  }

  function handleTextInput() {
    if (showAutocorrectDiff) {
      showAutocorrectDiff = false;
      originalTranscription = null;
    }
    updateAutocompleteFromInput();
  }

  function handleSelectionChange() {
    if (autocompleteOpen) updateAutocompleteFromInput();
  }

  function focusTextarea() {
    if (
      messagesState.messages.length == 0 &&
      !showSettings &&
      textareaElement
    ) {
      setTimeout(() => textareaElement?.focus(), 0);
    }
  }

  function focusInput() {
    if (textareaElement) setTimeout(() => textareaElement?.focus(), 0);
  }

  $effect(() => {
    if (!showSettings) {
      focusTextarea();
    }
  });

  function handleDocClick(e: MouseEvent) {
    if (!attachMenuOpen) return;
    const target = e.target as HTMLElement;
    if (!target.closest("[data-attach-root]")) {
      closeAttachMenu();
    }
  }

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
        await invoke("set_input_shortcuts", { bindings: readInputBindings() });
      } catch (e) {
        console.warn("[user-input] set_input_shortcuts failed:", e);
      }
    }
    async function clearInputShortcuts() {
      try {
        await invoke("set_input_shortcuts", { bindings: [] });
      } catch (e) {
        console.warn("[user-input] clear input_shortcuts failed:", e);
      }
    }

    // Focus the textarea on show, and (de)register input shortcuts in lockstep
    // with window visibility. Rust emits `window-visibility` with `true` on
    // show and `false` on hide.
    void listen<boolean>("window-visibility", ({ payload: visible }) => {
      if (visible) {
        focusTextarea();
        void registerInputShortcuts();
      } else {
        void clearInputShortcuts();
      }
    }).then((unlisten) => {
      cleanups.push(unlisten);
    });

    // Click-outside to close attachment menu
    document.addEventListener("click", handleDocClick, true);
    cleanups.push(() =>
      document.removeEventListener("click", handleDocClick, true),
    );

    void listen("input-shortcut-attach-file", () => {
      void handleAttachFileFromMenu();
    }).then((u) => cleanups.push(u));
    void listen("input-shortcut-capture-screen", () => {
      // Pick the primary monitor from the captureMonitors snapshot, falling
      // back to the first id we see. captureMonitors is populated lazily via
      // the attach-menu open path; if it's empty we still try to fetch.
      void (async () => {
        let monitors = captureMonitors;
        if (monitors.length === 0) {
          monitors = await listCaptureMonitors();
          captureMonitors = monitors;
        }
        const target = monitors.find((m) => m.isPrimary)?.id || monitors[0]?.id;
        if (target) await captureMonitorById(target);
      })();
    }).then((u) => cleanups.push(u));
    void listen("input-shortcut-capture-region", () => {
      void handleCaptureRegionFromMenu();
    }).then((u) => cleanups.push(u));
    cleanups.push(() => {
      void clearInputShortcuts();
    });

    // Initial registration: only if the window is already visible at mount
    // time. Most of the time it is (closing Settings doesn't hide the window),
    // but on app startup with a hidden tray-only launch we'd otherwise
    // register shortcuts that should be inactive.
    void (async () => {
      try {
        const visible = (await getCurrentWindow().isVisible()) ?? true;
        if (visible) await registerInputShortcuts();
      } catch (e) {
        console.warn("[user-input] initial visibility check failed:", e);
      }
    })();

    // Async setup: monitors, VAD, shortcut listeners, persistent-mode restore.
    // Monitors are best-effort (benign on failure); VAD and shortcut setup
    // failures surface via the sttError banner because DevTools aren't
    // available in the packaged app.
    void (async () => {
      try {
        try {
          const m = await availableMonitors();
          monitors = m.map((mon, i) => ({
            id: mon.name || i.toString(),
            name: mon.name || `Monitor ${i + 1}`,
            isPrimary: false,
          }));
        } catch (err) {
          console.warn("Could not fetch monitors", err);
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
        console.error("[user-input] init failed:", err);
        const detail = err instanceof Error ? err.message : String(err);
        sttError = `Voice input setup failed: ${detail}`;
        if (sttErrorTimeout) clearTimeout(sttErrorTimeout);
        sttErrorTimeout = setTimeout(() => {
          sttError = null;
        }, 8000);
      }
    })();

    return () => {
      for (const c of cleanups) c();
    };
  });

  onDestroy(() => {
    vadManager.detach();
    if (sttErrorTimeout) {
      clearTimeout(sttErrorTimeout);
      sttErrorTimeout = null;
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
    // dropped on the floor — user sees a queued message that never streams.
    if (connectionState.state !== "connected") return;

    const trimmedText = text.trim();
    if (!trimmedText && attachments.length === 0) return;

    showAutocorrectDiff = false;
    originalTranscription = null;

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
    autocompleteOpen = false;

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
      console.error("[ui] sendMessages failed:", err);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (autocompleteOpen && autocompleteOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        autocompleteIndex =
          (autocompleteIndex + 1) % autocompleteOptions.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        autocompleteIndex =
          (autocompleteIndex - 1 + autocompleteOptions.length) %
          autocompleteOptions.length;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = autocompleteOptions[autocompleteIndex];
        if (selected) applySnippetTrigger(selected);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        autocompleteOpen = false;
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!hasActiveWork) handleSend();
    }
  }

  async function handleVadAudio(audio: Float32Array) {
    showAutocorrectDiff = false;
    originalTranscription = null;

    const wavBlob = float32ToWav(audio, 16000);
    const base64 = await blobToBase64(wavBlob);

    const result = await transcribeAudio(base64);
    if (result.error) {
      if (sttErrorTimeout) clearTimeout(sttErrorTimeout);
      sttError = result.error;
      sttErrorTimeout = setTimeout(() => {
        sttError = null;
      }, 5000);
      return;
    }
    if (!result.text) return;

    const transcription = result.text.trim();
    if (!transcription) return;

    const existing = text;
    let raw = transcription;
    let corrected: string | null = null;

    if (settingsState.currentSettings["stt.llmAutocorrect"]) {
      try {
        const result = await autocorrectTranscription(raw);
        if (result) corrected = result;
      } catch (e) {
        console.warn("[stt] Autocorrect failed:", e);
      }
    }

    const chainEnabled =
      settingsState.currentSettings["stt.llmChainTranscription"] &&
      existing.trim().length > 0;

    if (chainEnabled) {
      try {
        const mergedRaw = await mergeTranscription(existing, raw);
        if (mergedRaw) raw = mergedRaw;
        if (corrected) {
          const mergedCorrected = await mergeTranscription(existing, corrected);
          if (mergedCorrected) corrected = mergedCorrected;
        }
      } catch (e) {
        console.warn("[stt] Merge transcription failed:", e);
      }
    }

    if (corrected) {
      text = corrected;
      const changed = corrected.trim() !== raw.trim();
      originalTranscription = changed ? raw : null;
      showAutocorrectDiff = changed;
    } else {
      text = raw;
      originalTranscription = null;
      showAutocorrectDiff = false;
    }
    textareaElement?.focus();

    if (settingsState.currentSettings["stt.autoSend"]) {
      if (streamingState.hasActiveWork) {
        await streamingState.interruptStreaming();
      }
      await handleSend();
    }
  }

  const DOC_EXTENSIONS = [
    "pdf",
    "docx",
    "pptx",
    "xlsx",
    "xls",
    "csv",
    "html",
    "htm",
    "txt",
    "md",
    "json",
    "xml",
    "rst",
    "log",
    "toml",
    "yaml",
    "ini",
    "py",
    "rs",
    "js",
    "ts",
    "c",
    "cpp",
    "go",
    "java",
  ];

  const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

  const MIME_BY_EXT: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };

  async function ingestImageBlob(blob: Blob, filename: string, ext: string) {
    const mime = blob.type || MIME_BY_EXT[ext] || "image/png";
    const base64 = await blobToBase64(new Blob([blob], { type: mime }));
    attachments = [
      ...attachments,
      { type: "image", filename, pendingData: base64, mime },
    ];
  }

  async function ingestDocumentBlob(blob: Blob, filename: string) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const tmpDir = await tempDir();
    const tmpPath = await join(tmpDir, `tomat-paste-${Date.now()}-${filename}`);
    try {
      await writeFile(tmpPath, buf);
      const markdown = (await invoke("convert_file_to_markdown", {
        filePath: tmpPath,
      })) as string;
      attachments = [
        ...attachments,
        { type: "document", filename, pendingData: markdown },
      ];
    } finally {
      try {
        await remove(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length === 0) return;

    const supportsImages = settingsState.currentSettings["llm.supportImages"];
    let handledAny = false;

    for (const file of files) {
      const name = file.name || "pasted";
      const ext = name.split(".").pop()?.toLowerCase() || "";
      const isImage =
        supportsImages &&
        (IMAGE_EXTENSIONS.includes(ext) || file.type.startsWith("image/"));
      const isDoc = DOC_EXTENSIONS.includes(ext);
      if (!isImage && !isDoc) continue;

      handledAny = true;
      try {
        if (isImage) {
          const imgExt = IMAGE_EXTENSIONS.includes(ext) ? ext : "png";
          const baseName = name.includes(".") ? name : `${name}.${imgExt}`;
          await ingestImageBlob(file, baseName, imgExt);
        } else {
          await ingestDocumentBlob(file, name);
        }
      } catch (err) {
        console.error("[attach] Paste ingestion failed:", err);
      }
    }

    if (handledAny) e.preventDefault();
  }

  async function handleAttachFile() {
    try {
      const supportsImages = settingsState.currentSettings["llm.supportImages"];

      const docExtensions = DOC_EXTENSIONS;
      const imageExtensions = IMAGE_EXTENSIONS;

      const filters = [
        {
          name: "Documents",
          extensions: docExtensions,
        },
      ];

      if (supportsImages) {
        filters.push({
          name: "Images",
          extensions: imageExtensions,
        });
      }

      // Shrink window and center Y to prevent macOS dimming overlay on transparent window
      const win = getCurrentWindow();
      const savedSize = await win.outerSize();
      const savedPos = await win.outerPosition();
      const monitor = await currentMonitor();
      const centerX = Math.round(savedPos.x + savedSize.width / 2);
      const centerY = monitor
        ? Math.round(monitor.position.y + monitor.size.height / 3)
        : savedPos.y;
      await pauseClickThrough();
      await win.setSize(new PhysicalSize(1, 1));
      await win.setPosition(new PhysicalPosition(centerX, centerY));

      let selected;
      try {
        selected = await open({
          multiple: false,
          directory: false,
          filters,
        });
      } finally {
        await win.setPosition(new PhysicalPosition(savedPos.x, savedPos.y));
        await win.setSize(new PhysicalSize(savedSize.width, savedSize.height));
        await resumeClickThrough();
      }

      if (!selected) return;

      const filePath = typeof selected === "string" ? selected : selected;
      const fileName =
        filePath.split("/").pop() || filePath.split("\\").pop() || "file";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";

      const isImage = imageExtensions.includes(ext);

      if (isImage) {
        const data = await readFile(filePath);
        const mime = MIME_BY_EXT[ext] || "image/png";
        const blob = new Blob([data], { type: mime });
        const base64 = await blobToBase64(blob);
        attachments = [
          ...attachments,
          { type: "image", filename: fileName, pendingData: base64, mime },
        ];
      } else {
        const markdown = (await invoke("convert_file_to_markdown", {
          filePath,
        })) as string;
        attachments = [
          ...attachments,
          { type: "document", filename: fileName, pendingData: markdown },
        ];
      }
      focusInput();
    } catch (err) {
      console.error("[attach] File attach failed:", err);
    }
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index);
  }

  async function toggleAttachMenu() {
    if (attachMenuOpen) {
      attachMenuOpen = false;
    } else {
      attachMenuOpen = true;
      captureMonitors = await listCaptureMonitors();
    }
  }

  function closeAttachMenu() {
    attachMenuOpen = false;
  }

  async function handleAttachFileFromMenu() {
    closeAttachMenu();
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
    closeAttachMenu();
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
    closeAttachMenu();
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
  <!-- STT error banner -->
  {#if sttError}
    <div
      class="flex items-center gap-2 text-sm text-default-700 bg-default-200 rounded-medium px-3 py-2"
    >
      <i class="flex i-material-symbols-mic-off-rounded text-base"></i>
      <span>{sttError}</span>
    </div>
  {/if}

  <!-- LLM autocorrect before -->
  {#if showAutocorrectDiff && originalTranscription !== null}
    <div
      class="flex items-start gap-2 text-sm text-default-700 bg-default-200 rounded-medium px-3 py-2"
    >
      <span class="shrink-0 font-medium">Before Autocorrect:</span>
      <span class="whitespace-pre-wrap break-words flex-1"
        >{originalTranscription}</span
      >
      <button
        class="shrink-0 hover:text-default-900 hover:cursor-pointer rounded p-1 flex items-center text-base"
        title="Reject autocorrect"
        onclick={() => {
          if (originalTranscription !== null) text = originalTranscription;
          showAutocorrectDiff = false;
          originalTranscription = null;
          textareaElement?.focus();
        }}
      >
        <i class="flex i-material-symbols-refresh-rounded"></i>
      </button>
    </div>
  {/if}

  <div class="grid w-fit min-w-0 max-w-[calc(100vw-135px)] overflow-clip">
    <!-- Hidden span for the typed text to dynamically expand width and height. Safely renders newlines.
         Doubles as a layout mirror for caret measurement (see measureCaretAt). -->
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
      onblur={() => (autocompleteOpen = false)}
      onpaste={handlePaste}
      autocapitalize="on"
      autocomplete="off"
      rows="1"
      cols="1"
      class="col-start-1 row-start-1 bg-transparent outline-none min-w-0 w-full max-w-[calc(100vw-80px)] max-w-full overflow-hidden resize-none whitespace-pre-wrap break-words"
      placeholder={placeholderText}
      disabled={downloadsState.hasPendingStartup ||
        connectionState.state !== "connected" ||
        (llmStatus !== "Running" && llmStatus !== "Disabled")}
    ></textarea>
  </div>

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
    <div
      class="flex flex-row items-center justify-center bg-default-200 p-1 rounded-large"
      data-attach-root
    >
      <button
        class="hover:text-default-900 hover:cursor-pointer rounded p-1 flex items-center shrink-0 text-default-700"
        title={attachMenuOpen ? "Close" : "Attach"}
        onclick={toggleAttachMenu}
      >
        <i
          class="flex i-material-symbols-add-rounded transition-transform duration-100 {attachMenuOpen
            ? 'rotate-45'
            : ''}"
        ></i>
      </button>

      <button
        class="hover:text-default-900 hover:cursor-pointer rounded flex items-center shrink-0 overflow-hidden transition-all duration-100 {attachMenuOpen
          ? 'w-8 p-1 opacity-100'
          : 'w-0 p-0 opacity-0 pointer-events-none'}"
        title="Attach File"
        onclick={handleAttachFileFromMenu}
        tabindex={attachMenuOpen ? 0 : -1}
      >
        <i class="flex i-material-symbols-attach-file-rounded"></i>
      </button>

      <div
        class="relative shrink-0 flex items-center overflow-hidden transition-all duration-100 rounded hover:text-default-900 {attachMenuOpen
          ? 'w-8 p-1 opacity-100'
          : 'w-0 p-0 opacity-0 pointer-events-none'}"
      >
        <i class="flex i-material-symbols-screenshot-monitor-outline-rounded"
        ></i>
        <select
          class="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base"
          title="Screen Capture"
          aria-label="Screen Capture Monitor"
          onchange={handleCaptureSelect}
          disabled={!attachMenuOpen || capturing}
          tabindex={attachMenuOpen ? 0 : -1}
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

      <button
        class="hover:text-default-900 hover:cursor-pointer rounded flex items-center shrink-0 overflow-hidden transition-all duration-100 {attachMenuOpen
          ? 'w-8 p-1 opacity-100'
          : 'w-0 p-0 opacity-0 pointer-events-none'}"
        title="Capture Region"
        aria-label="Capture Screen Region"
        onclick={handleCaptureRegionFromMenu}
        disabled={!attachMenuOpen || capturing}
        tabindex={attachMenuOpen ? 0 : -1}
      >
        <i class="flex i-material-symbols-crop-free-rounded"></i>
      </button>

      {#if attachMenuOpen}
        <div class="flex h-full w-1"></div>
      {/if}
    </div>

    <div
      class="flex flex-row items-center justify-center bg-default-200 px-2 py-1 rounded-large"
    >
      <div
        class="relative flex items-center p-1 text-default-700 hover:text-default-900 transition-colors"
      >
        <i class="i-material-symbols-desktop-windows-outline-rounded"></i>
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
          <button
            class="hover:text-default-900 hover:cursor-pointer rounded p-1 flex items-center text-default-700"
            onclick={() => handleAlignment(align.value)}
            title={align.title}
          >
            <i class="flex {align.icon}"></i>
          </button>
        {/each}
      </div>

      <button
        class=" hover:text-default-900 hover:cursor-pointer rounded p-1 flex items-center transition-colors duration-300 {showSettings
          ? 'text-blue-400'
          : pendingBlinkOn
            ? 'text-default-900'
            : 'text-default-700'}"
        onclick={toggleSettings}
        title={downloadsState.hasPendingStartup
          ? "Pending downloads - open settings"
          : "Settings"}
      >
        <i class="flex i-material-symbols-settings-outline-rounded"></i>
      </button>
    </div>

    <div class="flex gap-2">
      {#if settingsState.currentSettings["stt.enabled"]}
        <button
          class="bg-default-200 p-2 rounded-large flex items-center transition-colors {vadManager.enabled
            ? vadManager.listening
              ? 'text-green-500'
              : 'text-blue-400'
            : sttStatus === 'Running' || sttStatus === 'Disabled'
              ? 'hover:text-default-900 hover:cursor-pointer text-default-700'
              : 'cursor-not-allowed'}"
          title={vadManager.enabled
            ? vadManager.listening
              ? "Listening..."
              : "VAD Active (click to disable)"
            : sttStatus === "Running" || sttStatus === "Disabled"
              ? "Enable Voice Input"
              : "Voice Input (Unavailable)"}
          onclick={() => vadManager.toggle()}
          disabled={vadManager.loading ||
            (sttStatus !== "Running" &&
              sttStatus !== "Disabled" &&
              !vadManager.enabled)}
        >
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
                : sttStatus === 'Running' || sttStatus === 'Disabled'
                  ? 'i-material-symbols-mic-outline-rounded'
                  : 'i-material-symbols-mic-off-outline-rounded'}"
            ></i>
          {/if}
        </button>
      {/if}
      <button
        class="hover:cursor-pointer bg-default-200 p-2 rounded-large flex items-center transition-colors {hasActiveWork &&
        !hasContent
          ? 'text-red-500 hover:text-red-400'
          : 'hover:text-default-900 text-default-700'}"
        title={hasActiveWork && !hasContent
          ? "Stop"
          : hasActiveWork && hasContent
            ? "Interrupt and Send"
            : "Send"}
        onclick={hasActiveWork && !hasContent
          ? handleStop
          : hasActiveWork && hasContent
            ? handleInterruptAndSend
            : handleSend}
      >
        <i
          class="flex {hasActiveWork && !hasContent
            ? 'i-material-symbols-stop-rounded'
            : hasActiveWork && hasContent
              ? 'i-material-symbols-arrow-upward-rounded'
              : 'i-material-symbols-send-outline-rounded'}"
        ></i>
      </button>
    </div>
  </div>
</Bubble>
</div>

<svelte:window onkeydown={handlePreviewKeydown} onblur={closeImagePreview} />

{#if autocompleteOpen}
  <div style:display="contents" style:--default-base={themeOverrideHex}>
    <SnippetAutocomplete
      options={autocompleteOptions}
      selectedIndex={autocompleteIndex}
      anchor={autocompleteAnchor}
      onSelect={applySnippetTrigger}
    />
  </div>
{/if}

{#if previewImageUrl}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-auto"
    onclick={closeImagePreview}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div onclick={(e) => e.stopPropagation()}>
      <img
        src={previewImageUrl}
        alt="Preview"
        class="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-6rem)] object-contain rounded-medium shadow-2xl"
      />
    </div>
  </div>
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
