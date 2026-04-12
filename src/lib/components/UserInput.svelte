<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type {
    Alignment,
    Monitor,
    Attachment,
    MessageContent,
    MessagePart,
  } from "$lib/shared/types";
  import { availableMonitors } from "@tauri-apps/api/window";
  import { listen } from "@tauri-apps/api/event";
  import { messagesState, serversState, settingsState } from "../state";
  import { sendMessages } from "$lib/sidecar/llm";
  import { transcribeAudio } from "$lib/sidecar/stt";
  import { autocorrectTranscription } from "$lib/sidecar/llm";
  import { float32ToWav, blobToBase64 } from "$lib/shared/audio";
  import {
    pauseClickThrough,
    resumeClickThrough,
  } from "$lib/shared/clickthrough";
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

  // VAD state
  let vadEnabled = $state(false);
  let vadInstance: any = null;
  let vadDestroyed = false;
  let isListening = $state(false); // true when speech is currently detected
  let vadLoading = $state(false);

  let vadPausedByHide = false; // true if VAD was paused due to window hide
  let unlistenVisibility: (() => void) | null = null;

  let sttError = $state<string | null>(null);
  let sttErrorTimeout: ReturnType<typeof setTimeout> | null = null;

  let llmStatus = $derived(serversState.serverStatuses.llm.status);
  let isStreaming = $derived(messagesState.isStreaming);
  let hasContent = $derived(text.trim().length > 0 || attachments.length > 0);
  let placeholderText = $derived(
    vadEnabled && isListening
      ? "Listening..."
      : vadEnabled
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

  /** Convert Attachment[] to MessagePart[] for display in AttachmentList */
  let attachmentParts = $derived(
    attachments.map((att): MessagePart => {
      if (att.type === "image") {
        return {
          type: "image_url",
          image_url: {
            url: `data:${att.mime || "image/png"};base64,${att.data}`,
          },
        };
      }
      return { type: "document", filename: att.filename, markdown: att.data };
    }),
  );

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

  onMount(() => {
    window.addEventListener("focus", focusTextarea);
    return () => window.removeEventListener("focus", focusTextarea);
  });

  onMount(async () => {
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
  });

  onMount(async () => {
    unlistenVisibility = await listen<boolean>(
      "window-visibility",
      ({ payload: visible }) => {
        if (!visible && vadEnabled && vadInstance) {
          vadInstance.pause();
          isListening = false;
          vadPausedByHide = true;
        } else if (visible && vadPausedByHide && vadInstance) {
          vadInstance.start();
          vadPausedByHide = false;
        }
      },
    );
  });

  onDestroy(() => {
    vadDestroyed = true;
    if (vadInstance) {
      vadInstance.destroy();
      vadInstance = null;
    }
    unlistenVisibility?.();
  });

  function handleMonitorChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const monitorId = target.value;
    settingsState.updateSetting("layout.monitor", monitorId);
  }

  function handleAlignment(align: Alignment) {
    settingsState.updateSetting("layout.alignment", align);
  }

  function buildMessageContent(): MessageContent {
    const parts: MessagePart[] = [];

    if (text.trim()) {
      parts.push({ type: "text", text: text.trim() });
    }

    for (const att of attachments) {
      if (att.type === "image") {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${att.mime || "image/png"};base64,${att.data}`,
          },
        });
      } else if (att.type === "document") {
        parts.push({
          type: "document",
          filename: att.filename,
          markdown: att.data,
        });
      }
    }

    // If only text, return as string for simplicity
    if (parts.length === 1 && parts[0].type === "text") {
      return parts[0].text;
    }
    return parts;
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

    const content = buildMessageContent();
    const hasContentToSend =
      typeof content === "string"
        ? content.trim().length > 0
        : content.length > 0;

    if (!hasContentToSend) return;

    messagesState.addMessage({ role: "user", content });
    text = "";
    attachments = [];

    try {
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

  // --- VAD ---

  async function toggleVad() {
    if (vadEnabled) {
      // Disable
      if (vadInstance) {
        vadInstance.destroy();
        vadInstance = null;
      }
      vadEnabled = false;
      isListening = false;
    } else {
      // Enable
      vadLoading = true;
      try {
        const { MicVAD } = await import("@ricky0123/vad-web");

        const instance = await MicVAD.new({
          baseAssetPath: "/vad/",
          onnxWASMBasePath: "/vad/",
          model: "v5",
          onSpeechStart: () => {
            isListening = true;
          },
          onSpeechEnd: async (audio: Float32Array) => {
            isListening = false;
            await handleVadAudio(audio);
          },
          onVADMisfire: () => {
            isListening = false;
          },
        });

        if (vadDestroyed) {
          instance.destroy();
          return;
        }

        vadInstance = instance;
        vadInstance.start();
        vadEnabled = true;
      } catch (err) {
        console.error("[vad] Failed to initialize VAD:", err);
        vadEnabled = false;
      } finally {
        vadLoading = false;
      }
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

    // LLM Autocorrect
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

    // Auto Send
    if (settingsState.currentSettings["stt.autoSend"]) {
      if (messagesState.isStreaming) {
        await messagesState.interruptStreaming();
      }
      await handleSend();
    }
  }

  // --- File Picker ---

  async function handleAttachFile() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");

      const supportsImages = settingsState.currentSettings["llm.supportImages"];

      const docExtensions = [
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

      const imageExtensions = [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "bmp",
        "svg",
      ];

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
        // Read image as binary, convert to base64 efficiently via Blob + FileReader
        const data = await readFile(filePath);
        const mimeMap: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
          svg: "image/svg+xml",
        };
        const mime = mimeMap[ext] || "image/png";
        const blob = new Blob([data], { type: mime });
        const base64 = await blobToBase64(blob);
        // blobToBase64 returns raw base64 (no prefix), we store with mime for the data URL
        attachments = [
          ...attachments,
          { type: "image", filename: fileName, data: base64, mime },
        ];
      } else {
        // Convert document to markdown via Rust
        const { invoke } = await import("@tauri-apps/api/core");
        const markdown = (await invoke("convert_file_to_markdown", {
          filePath,
        })) as string;
        attachments = [
          ...attachments,
          { type: "document", filename: fileName, data: markdown },
        ];
      }
    } catch (err) {
      console.error("[attach] File attach failed:", err);
    }
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index);
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
      autocapitalize="on"
      autocomplete="off"
      rows="1"
      cols="1"
      class="col-start-1 row-start-1 bg-transparent outline-none min-w-0 w-full max-w-[calc(100vw-80px)] max-w-full overflow-hidden resize-none whitespace-pre-wrap break-words {llmStatus !==
        'Running' && llmStatus !== 'Disabled'
        ? 'opacity-50'
        : ''}"
      placeholder={placeholderText}
      disabled={(llmStatus !== "Running" && llmStatus !== "Disabled") ||
        vadEnabled}
    ></textarea>
  </div>

  <!-- Attachment previews -->
  <AttachmentList
    parts={attachmentParts}
    editable
    onRemove={removeAttachment}
  />

  <div
    class="flex items-end justify-between gap-2 text-2xl text-default-500 w-full"
  >
    <button
      class="hover:text-default-900 hover:cursor-pointer bg-default-100 p-2 rounded-2xl flex items-center transition-colors"
      title="Attach File"
      onclick={handleAttachFile}
    >
      <i class="flex i-material-symbols-add-rounded"></i>
    </button>

    <div
      class="flex flex-row items-center justify-center bg-default-100 px-2 py-1 rounded-2xl"
    >
      <div
        class="relative flex items-center p-1 text-default-500 hover:text-default-900 transition-colors"
      >
        <i class="i-material-symbols-desktop-windows-outline-rounded"></i>
        <select
          class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
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
      <button
        class="bg-default-100 p-2 rounded-2xl flex items-center transition-colors {vadLoading
          ? 'text-default-300 cursor-wait'
          : vadEnabled
            ? isListening
              ? 'text-green-500 animate-pulse'
              : 'text-blue-400'
            : sttStatus === 'Running' || sttStatus === 'Disabled'
              ? 'hover:text-default-900 hover:cursor-pointer text-default-500'
              : 'text-default-300 cursor-not-allowed'}"
        title={vadEnabled
          ? isListening
            ? "Listening..."
            : "VAD Active (click to disable)"
          : sttStatus === "Running" || sttStatus === "Disabled"
            ? "Enable Voice Input"
            : "Voice Input (Unavailable)"}
        onclick={toggleVad}
        disabled={vadLoading ||
          (sttStatus !== "Running" && sttStatus !== "Disabled" && !vadEnabled)}
      >
        <i
          class="flex {vadEnabled
            ? isListening
              ? 'i-material-symbols-sync-rounded animate-spin'
              : 'i-material-symbols-mic-rounded'
            : sttStatus === 'Running' || sttStatus === 'Disabled'
              ? 'i-material-symbols-mic-outline-rounded'
              : 'i-material-symbols-mic-off-outline-rounded'}"
        ></i>
      </button>
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
