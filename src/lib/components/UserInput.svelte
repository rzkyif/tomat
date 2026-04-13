<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type {
    Alignment,
    Monitor,
    Attachment,
    MessagePart,
  } from "$lib/shared/types";
  import { availableMonitors } from "@tauri-apps/api/window";
  import { messagesState, serversState, settingsState } from "../state";
  import { shortcutHandler } from "$lib/state/shortcut.svelte";
  import { sendMessages } from "$lib/sidecar/llm";
  import { transcribeAudio } from "$lib/sidecar/stt";
  import { autocorrectTranscription } from "$lib/sidecar/llm";
  import { float32ToWav, blobToBase64 } from "$lib/shared/audio";
  import {
    pauseClickThrough,
    resumeClickThrough,
  } from "$lib/shared/clickthrough";
  import { invoke } from "@tauri-apps/api/core";
  import {
    listCaptureMonitors,
    captureMonitor,
    type CaptureMonitorInfo,
  } from "$lib/shared/capture";
  import { vadManager } from "$lib/shared/vad.svelte";
  import type { SmartSTTMode } from "$lib/shared/settings";
  import AttachmentList from "./AttachmentList.svelte";
  import Bubble from "./Bubble.svelte";

  let { toggleSettings, showSettings } = $props<{
    toggleSettings: () => void;
    showSettings: boolean;
  }>();

  let text = $state("");
  let monitors: Monitor[] = $state([]);
  let textareaElement: HTMLTextAreaElement | undefined = $state();
  let attachments = $state<Attachment[]>([]);

  let attachMenuOpen = $state(false);
  let captureMonitors = $state<CaptureMonitorInfo[]>([]);
  let capturing = $state(false);

  let sttError = $state<string | null>(null);
  let sttErrorTimeout: ReturnType<typeof setTimeout> | null = null;

  let llmStatus = $derived(serversState.serverStatuses.llm.status);
  let isStreaming = $derived(messagesState.isStreaming);
  let hasContent = $derived(text.trim().length > 0 || attachments.length > 0);
  let placeholderText = $derived(
    vadManager.enabled && vadManager.listening
      ? "Listening..."
      : vadManager.enabled
        ? "Waiting for speech..."
        : llmStatus === "Error"
          ? "LLM server failed to start!"
          : llmStatus === "Downloading"
            ? "Downloading LLM model, please wait..."
            : llmStatus === "Loading"
              ? "Starting LLM server, please wait..."
              : "Enter your instructions...",
  );
  let sttStatus = $derived(serversState.serverStatuses.stt.status);

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

  function focusTextarea() {
    if (
      messagesState.messages.length == 0 &&
      !showSettings &&
      textareaElement
    ) {
      setTimeout(() => textareaElement?.focus(), 0);
    }
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

    // Focus management
    window.addEventListener("focus", focusTextarea);
    cleanups.push(() => window.removeEventListener("focus", focusTextarea));

    // Click-outside to close attachment menu
    document.addEventListener("click", handleDocClick, true);
    cleanups.push(() =>
      document.removeEventListener("click", handleDocClick, true),
    );

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
        await shortcutHandler.attach();

        const mode = settingsState.currentSettings[
          "stt.smartStt"
        ] as SmartSTTMode;
        if (
          mode === "persistent" &&
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
    shortcutHandler.detach();
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
    await messagesState.interruptStreaming();
  }

  async function handleInterruptAndSend(): Promise<void> {
    await messagesState.interruptStreaming();
    await handleSend();
  }

  async function handleSend() {
    if (isStreaming) return;

    const trimmedText = text.trim();
    if (!trimmedText && attachments.length === 0) return;

    const snapshot: Attachment[] = attachments.map((a) => ({
      type: a.type,
      filename: a.filename,
      pendingData: a.pendingData,
      mime: a.mime,
    }));
    const timestamp = Date.now();

    text = "";
    attachments = [];

    try {
      await messagesState.addUserMessage({
        text: trimmedText,
        attachments: snapshot,
        timestamp,
      });
      await sendMessages();
    } catch (err) {
      console.error("[ui] sendMessages failed:", err);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
  }

  async function handleVadAudio(audio: Float32Array) {
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

    let transcription = result.text.trim();
    if (!transcription) return;

    if (settingsState.currentSettings["stt.llmAutocorrect"]) {
      try {
        const corrected = await autocorrectTranscription(transcription);
        if (corrected) transcription = corrected;
      } catch (e) {
        console.warn("[stt] Autocorrect failed:", e);
      }
    }

    text = transcription;
    textareaElement?.focus();

    if (settingsState.currentSettings["stt.autoSend"]) {
      if (messagesState.isStreaming) {
        await messagesState.interruptStreaming();
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

  const IMAGE_EXTENSIONS = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
  ];

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
    const { writeFile, remove } = await import("@tauri-apps/plugin-fs");
    const { tempDir, join } = await import("@tauri-apps/api/path");
    const buf = new Uint8Array(await blob.arrayBuffer());
    const tmpDir = await tempDir();
    const tmpPath = await join(
      tmpDir,
      `tomat-paste-${Date.now()}-${filename}`,
    );
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
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");

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
      const { PhysicalSize, PhysicalPosition } = await import(
        "@tauri-apps/api/dpi"
      );
      const savedSize = await win.outerSize();
      const savedPos = await win.outerPosition();
      const { currentMonitor } = await import("@tauri-apps/api/window");
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

<Bubble
  selectedAlignment={settingsState.getAlignment()}
  extraClass="flex flex-col gap-4 min-w-0 overflow-hidden transition-all"
  onclick={handleBubbleClick}
>
  <!-- STT error banner -->
  {#if sttError}
    <div
      class="flex items-center gap-2 text-sm text-default-500 bg-default-100 rounded-lg px-3 py-2"
    >
      <i class="flex i-material-symbols-mic-off-rounded text-base"></i>
      <span>{sttError}</span>
    </div>
  {/if}

  <div class="grid w-fit min-w-0 max-w-[calc(100vw-135px)] overflow-clip">
    <!-- Hidden span for the typed text to dynamically expand width and height. Safely renders newlines. -->
    <span
      class="invisible whitespace-pre-wrap break-words wrap-break-word col-start-1 row-start-1 pointer-events-none"
      >{text ? text + "\u200b" : placeholderText}</span
    >
    <textarea
      aria-label="Message input"
      bind:this={textareaElement}
      bind:value={text}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      autocapitalize="on"
      autocomplete="off"
      rows="1"
      cols="1"
      class="col-start-1 row-start-1 bg-transparent outline-none min-w-0 w-full max-w-[calc(100vw-80px)] max-w-full overflow-hidden resize-none whitespace-pre-wrap break-words {llmStatus !==
        'Running' && llmStatus !== 'Disabled'
        ? 'opacity-50'
        : ''}"
      placeholder={placeholderText}
      disabled={llmStatus !== "Running" && llmStatus !== "Disabled"}
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
    class="flex items-end justify-between gap-2 text-2xl text-default-500 w-full"
  >
    <div
      class="flex {settingsState.getAlignment() == 'right'
        ? 'flex-row-reverse'
        : 'flex-row'} items-center justify-center bg-default-100 p-1 rounded-2xl"
      data-attach-root
    >
      <button
        class="hover:text-default-900 hover:cursor-pointer rounded p-1 flex items-center shrink-0 text-default-600"
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

      {#if attachMenuOpen}
        <div class="flex h-full w-1"></div>
      {/if}
    </div>

    <div
      class="flex flex-row items-center justify-center bg-default-100 px-2 py-1 rounded-2xl"
    >
      <div
        class="relative flex items-center p-1 text-default-500 hover:text-default-900 transition-colors"
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
            class="hover:text-default-900 hover:cursor-pointer rounded p-1 flex items-center text-default-500"
            onclick={() => handleAlignment(align.value)}
            title={align.title}
          >
            <i class="flex {align.icon}"></i>
          </button>
        {/each}
      </div>

      <button
        class=" hover:text-default-900 hover:cursor-pointer rounded p-1 flex items-center {showSettings
          ? 'text-blue-400'
          : 'text-default-500'}"
        onclick={toggleSettings}
        title="Settings"
      >
        <i class="flex i-material-symbols-settings-outline-rounded"></i>
      </button>
    </div>

    <div class="flex gap-2">
      {#if settingsState.currentSettings["stt.preset"] !== "disabled"}
        <button
          class="bg-default-100 p-2 rounded-2xl flex items-center transition-colors {vadManager.loading
            ? 'text-default-300 cursor-wait'
            : vadManager.enabled
              ? vadManager.listening
                ? 'text-green-500'
                : 'text-blue-400'
              : sttStatus === 'Running' || sttStatus === 'Disabled'
                ? 'hover:text-default-900 hover:cursor-pointer text-default-500'
                : 'text-default-300 cursor-not-allowed'}"
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
          <i
            class="flex {vadManager.enabled
              ? vadManager.listening
                ? 'i-line-md:loading-twotone-loop'
                : 'i-material-symbols-mic-rounded'
              : sttStatus === 'Running' || sttStatus === 'Disabled'
                ? 'i-material-symbols-mic-outline-rounded'
                : 'i-material-symbols-mic-off-outline-rounded'}"
          ></i>
        </button>
      {/if}
      <button
        class="hover:cursor-pointer bg-default-100 p-2 rounded-2xl flex items-center transition-colors {isStreaming &&
        !hasContent
          ? 'text-red-500 hover:text-red-400'
          : 'hover:text-default-900 text-default-500'}"
        title={isStreaming && !hasContent
          ? "Stop"
          : isStreaming && hasContent
            ? "Interrupt and Send"
            : "Send"}
        onclick={isStreaming && !hasContent
          ? handleStop
          : isStreaming && hasContent
            ? handleInterruptAndSend
            : handleSend}
      >
        <i
          class="flex {isStreaming && !hasContent
            ? 'i-material-symbols-stop-rounded'
            : isStreaming && hasContent
              ? 'i-material-symbols-arrow-upward-rounded'
              : 'i-material-symbols-send-outline-rounded'}"
        ></i>
      </button>
    </div>
  </div>
</Bubble>

<svelte:window onkeydown={handlePreviewKeydown} onblur={closeImagePreview} />

{#if previewImageUrl}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-6"
    onclick={closeImagePreview}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div onclick={(e) => e.stopPropagation()}>
      <img
        src={previewImageUrl}
        alt="Preview"
        class="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-6rem)] object-contain rounded-lg shadow-2xl"
      />
    </div>
  </div>
{/if}
