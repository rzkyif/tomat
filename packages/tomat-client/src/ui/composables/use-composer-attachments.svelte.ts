/**
 * The composer's attachment pipeline: the pending attachment list plus every
 * way one gets added (file picker, mobile image/doc pickers, clipboard paste,
 * screen / region capture) and the image-preview modal state.
 *
 * Per the composable convention (see use-autocomplete), this class holds only
 * the `$state` and the imperative handlers; the consumer keeps the `$derived`
 * views (attachmentParts) and lifecycle (onMount capture-monitor fetch, the
 * input-shortcut wiring) and supplies its hooks (focus, onMobile, notice) via
 * the constructor context. It never reaches into the send/streaming path.
 */

import type { Attachment } from "$lib/util/types";
import { platform } from "$lib/platform";
import { getLogger } from "$lib/util/log";
import { settingsState } from "$stores/settings.svelte";
import {
  classifyAttachment,
  DOC_EXTENSIONS,
  IMAGE_EXTENSIONS,
  ingestDocumentBlob,
  ingestDocumentFromPath,
  ingestImageBlob,
  ingestTextDocument,
  MIME_BY_EXT,
  TEXT_DOC_EXTENSIONS,
} from "$lib/chat/attachments";
import { pauseClickThrough, resumeClickThrough } from "$lib/window/window";
import {
  captureMonitor,
  type CaptureMonitorInfo,
  captureRegion,
  listCaptureMonitors,
} from "$lib/capture/capture";

const attachLog = getLogger("attach");

export type ComposerAttachmentsContext = {
  // True on the Android client: pickers and the transparent-window dance differ.
  onMobile: boolean;
  // Refocus the textarea after an attachment lands (desktop only; the consumer
  // suppresses it on mobile to keep the soft keyboard down).
  focus: () => void;
};

export class ComposerAttachments {
  attachments = $state<Attachment[]>([]);
  previewImageUrl = $state<string | null>(null);
  capturing = $state(false);
  captureMonitors = $state<CaptureMonitorInfo[]>([]);

  constructor(private readonly ctx: ComposerAttachmentsContext) {}

  /** Populate the monitor list for the always-visible screen-capture select.
   *  Called from the consumer's onMount; best-effort. */
  async loadCaptureMonitors(): Promise<void> {
    this.captureMonitors = await listCaptureMonitors();
  }

  clear(): void {
    this.attachments = [];
  }

  removeAttachment(index: number): void {
    this.attachments = this.attachments.filter((_, i) => i !== index);
  }

  openImagePreview(url: string): void {
    if (url) this.previewImageUrl = url;
  }

  closeImagePreview(): void {
    this.previewImageUrl = null;
  }

  async handlePaste(e: ClipboardEvent): Promise<void> {
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
          this.attachments = [...this.attachments, await ingestImageBlob(file, baseName, kind.ext)];
        } else {
          this.attachments = [...this.attachments, await ingestDocumentBlob(file, name)];
        }
      } catch (err) {
        attachLog.error("Paste ingestion failed:", err);
      }
    }

    if (handledAny) e.preventDefault();
  }

  // Android: the picker returns a content URI (not an absolute path), so picked
  // files are read as bytes. The OS offers no single files+photos picker, so the
  // composer shows two buttons backed by these two handlers. There is no
  // transparent-window dance to perform.
  //
  // Image picker: photos need no conversion, so any model-supported image is
  // ingested straight from its bytes.
  async handleAttachImageMobile(): Promise<void> {
    const supportsImages = settingsState.currentSettings["llm.supportImages"];
    if (!supportsImages) {
      attachLog.warn("this model has images disabled; the image picker is a no-op");
      return;
    }
    const picked = await platform().dialog.openFilePicker({
      multiple: false,
      filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    });
    if (picked.length === 0) return;
    const uri = picked[0];
    const data = await platform().fs.readFile(uri);
    const rawName = decodeURIComponent(uri.split("/").pop() || "image");
    const ext = rawName.split(".").pop()?.toLowerCase() || "";
    const safeExt = IMAGE_EXTENSIONS.includes(ext) ? ext : "png";
    const fileName = rawName.includes(".") ? rawName : `image.${safeExt}`;
    const mime = MIME_BY_EXT[safeExt] || "image/png";
    // .slice() yields a fresh non-shared ArrayBuffer, which Blob's BlobPart needs.
    const blob = new Blob([data.slice().buffer], { type: mime });
    this.attachments = [...this.attachments, await ingestImageBlob(blob, fileName, safeExt)];
  }

  // Document picker: the binary converter (anytomd/pdf-extract) is desktop-only,
  // so on mobile only the plain-text document types (txt, md, code, csv, json,
  // ...) are offered; their bytes are decoded as UTF-8 and ingested directly. A
  // binary office/pdf file picked anyway is skipped with a notice.
  async handleAttachDocMobile(): Promise<void> {
    const picked = await platform().dialog.openFilePicker({
      multiple: false,
      filters: [{ name: "Documents", extensions: TEXT_DOC_EXTENSIONS }],
    });
    if (picked.length === 0) return;
    const uri = picked[0];
    const rawName = decodeURIComponent(uri.split("/").pop() || "document.txt");
    const ext = rawName.split(".").pop()?.toLowerCase() || "";
    if (!TEXT_DOC_EXTENSIONS.includes(ext)) {
      attachLog.warn(`cannot attach .${ext} on mobile: it needs the desktop document converter`);
      return;
    }
    const fileName = rawName.includes(".") ? rawName : `${rawName}.txt`;
    const data = await platform().fs.readFile(uri);
    const text = new TextDecoder().decode(data);
    this.attachments = [...this.attachments, ingestTextDocument(text, fileName)];
  }

  async handleAttachFile(): Promise<void> {
    try {
      const supportsImages = settingsState.currentSettings["llm.supportImages"];

      if (this.ctx.onMobile) {
        // The composer's "Attach File" button is the document picker on mobile;
        // images have their own button (handleAttachImageMobile).
        await this.handleAttachDocMobile();
        return;
      }

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
      const centerY = monitor ? Math.round(monitor.y + monitor.height / 3) : savedPos.y;
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
        await win.setOuterSize({
          width: savedSize.width,
          height: savedSize.height,
        });
        await resumeClickThrough();
      }

      if (picked.length === 0) return;
      const filePath = picked[0];
      const fileName = filePath.split("/").pop() || filePath.split("\\").pop() || "file";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";

      if (IMAGE_EXTENSIONS.includes(ext)) {
        const data = await platform().fs.readFile(filePath);
        const mime = MIME_BY_EXT[ext] || "image/png";
        // .slice() returns a Uint8Array backed by a fresh non-shared
        // ArrayBuffer, which Blob's `BlobPart` signature requires.
        const blob = new Blob([data.slice().buffer], { type: mime });
        this.attachments = [...this.attachments, await ingestImageBlob(blob, fileName, ext)];
      } else {
        this.attachments = [...this.attachments, await ingestDocumentFromPath(filePath, fileName)];
      }
      this.ctx.focus();
    } catch (err) {
      attachLog.error("File attach failed:", err);
    }
  }

  handleCaptureSelect(e: Event): void {
    const target = e.target as HTMLSelectElement;
    const id = target.value;
    target.value = "";
    if (id) void this.captureMonitorById(id);
  }

  async captureMonitorById(monitorId: string): Promise<void> {
    if (this.capturing) return;
    // A screenshot is an image attachment; skip when the model can't read images
    // (the capture controls are hidden then, but a bound shortcut still reaches
    // here).
    if (!settingsState.currentSettings["llm.supportImages"]) {
      attachLog.warn("screen capture skipped: image support is off");
      return;
    }
    this.capturing = true;
    try {
      const base64 = await captureMonitor(monitorId);
      if (base64) {
        this.attachments = [
          ...this.attachments,
          {
            type: "image",
            filename: `screenshot-${Date.now()}.png`,
            pendingData: base64,
            mime: "image/png",
          },
        ];
        this.ctx.focus();
      }
    } finally {
      this.capturing = false;
    }
  }

  async handleCaptureRegionFromMenu(): Promise<void> {
    if (this.capturing) return;
    if (!settingsState.currentSettings["llm.supportImages"]) {
      attachLog.warn("region capture skipped: image support is off");
      return;
    }
    this.capturing = true;
    try {
      const base64 = await captureRegion();
      if (base64) {
        this.attachments = [
          ...this.attachments,
          {
            type: "image",
            filename: `region-${Date.now()}.png`,
            pendingData: base64,
            mime: "image/png",
          },
        ];
        this.ctx.focus();
      }
    } finally {
      this.capturing = false;
    }
  }
}
