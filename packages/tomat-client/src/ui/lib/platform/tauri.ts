// Tauri implementation of the Platform interface. The only file outside of
// itself that may import `@tauri-apps/*` (enforced by oxlint).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  availableMonitors as tauriAvailableMonitors,
  currentMonitor as tauriCurrentMonitor,
  cursorPosition,
  getCurrentWindow,
  primaryMonitor as tauriPrimaryMonitor,
  type Monitor as TauriMonitor,
} from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { join as tauriJoin, tempDir as tauriTempDir } from "@tauri-apps/api/path";
import { getVersion as tauriGetVersion } from "@tauri-apps/api/app";
import { Menu, type MenuItemOptions } from "@tauri-apps/api/menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  readFile as tauriReadFile,
  remove,
  writeFile as tauriWriteFile,
} from "@tauri-apps/plugin-fs";
import {
  check as tauriUpdaterCheck,
  type Update,
} from "@tauri-apps/plugin-updater";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import {
  setPlatform,
  type ContextMenuItem,
  type MonitorInfo,
  type Platform,
  type UpdateHandle,
} from "./index";

export function installTauriPlatform(): void {
  setPlatform(impl);
}

const impl: Platform = {
  windowing: {
    show: () => invoke("show_main_window"),
    hide: () => invoke("hide_main_window"),
    toggle: () => invoke("toggle_main_window"),
    requestHide: () => invoke("request_hide_main_window"),
    async position(args) {
      await invoke("position_window", args);
    },
    async isVisible() {
      try {
        return (await getCurrentWindow().isVisible()) ?? false;
      } catch {
        return false;
      }
    },
    async subscribeVisibility(cb) {
      const unlisten = await listen<boolean>("window-visibility", (e) => cb(!!e.payload));
      return () => unlisten();
    },
    async outerSize() {
      const s = await getCurrentWindow().outerSize();
      return { width: s.width, height: s.height };
    },
    async outerPosition() {
      const p = await getCurrentWindow().outerPosition();
      return { x: p.x, y: p.y };
    },
    async setOuterSize({ width, height }) {
      await getCurrentWindow().setSize(new PhysicalSize(width, height));
    },
    async setOuterPosition({ x, y }) {
      await getCurrentWindow().setPosition(new PhysicalPosition(x, y));
    },
    async currentMonitor() {
      const m = await tauriCurrentMonitor();
      if (!m) return null;
      const primary = await tauriPrimaryMonitor();
      return toMonitorInfo(m, primary?.name === m.name);
    },
    async subscribeHideRequested(cb) {
      const unlisten = await listen("window-hide-requested", () => cb());
      return () => unlisten();
    },
    async subscribeMonitorChanged(cb) {
      const unlisten = await listen("monitor-changed", () => cb());
      return () => unlisten();
    },
  },
  capture: {
    monitors: () => invoke("list_capture_monitors"),
    captureMonitor: (monitorId) => invoke("capture_monitor", { monitorId }),
    setRegionTarget: (monitorId) => invoke("set_region_capture_target", { monitorId }),
    getRegionTarget: () => invoke("get_region_capture_target"),
    showRegionOverlay: () => invoke("show_region_capture_overlay"),
    hideRegionOverlay: () => invoke("hide_region_capture_overlay"),
    async subscribeRegionResult(cb) {
      const unResult: UnlistenFn = await listen<string>("region-capture-result", (e) =>
        cb(e.payload || null),
      );
      const unCancel: UnlistenFn = await listen("region-capture-cancelled", () => cb(null));
      return () => {
        unResult();
        unCancel();
      };
    },
  },
  audio: {
    getSystemVolume: () => invoke("get_system_volume"),
    setSystemVolume: (percent) => invoke("set_system_volume", { percent }),
    restoreSystemVolume: () => invoke("restore_system_volume"),
  },
  fonts: {
    list: () => invoke("list_system_fonts"),
  },
  shortcuts: {
    setBinding(accelerator) {
      return invoke("set_global_shortcut", { accelerator });
    },
    validate(accelerator) {
      return invoke("validate_shortcut", { accelerator });
    },
    async subscribeEvents({ onPressed, onReleased }) {
      const unPress: UnlistenFn = await listen("shortcut-pressed", () => onPressed());
      let unRelease: UnlistenFn | null = null;
      if (onReleased) {
        unRelease = await listen("shortcut-released", () => onReleased());
      }
      return () => {
        unPress();
        if (unRelease) unRelease();
      };
    },
    setInputBindings(bindings) {
      return invoke("set_input_shortcuts", { bindings });
    },
    async subscribeInputEvents({ onAttachFile, onCaptureScreen, onCaptureRegion }) {
      const unlisteners: UnlistenFn[] = [];
      if (onAttachFile) {
        unlisteners.push(await listen("input-shortcut-attach-file", () => onAttachFile()));
      }
      if (onCaptureScreen) {
        unlisteners.push(await listen("input-shortcut-capture-screen", () => onCaptureScreen()));
      }
      if (onCaptureRegion) {
        unlisteners.push(await listen("input-shortcut-capture-region", () => onCaptureRegion()));
      }
      return () => {
        for (const u of unlisteners) u();
      };
    },
  },
  clientSettings: {
    read: () => invoke("read_client_settings"),
    write: (settings) => invoke("write_client_settings", { settings }),
  },
  keychain: {
    set: (coreId, token) => invoke("keychain_set_token", { coreId, token }),
    get: (coreId) => invoke("keychain_get_token", { coreId }),
    delete: (coreId) => invoke("keychain_delete_token", { coreId }),
  },
  pairing: {
    readAdminToken: () => invoke("read_admin_token"),
    installLocalCore: (opts) =>
      invoke("install_local_core", {
        service: opts?.service ?? true,
        bindAll: opts?.bindAll ?? false,
      }),
    isLocalCoreInstalled: () => invoke("local_core_installed"),
    startLocalCore: () => invoke("start_local_core"),
  },
  fileConvert: {
    toMarkdownFromPath(absPath) {
      return invoke<string>("convert_file_to_markdown", { filePath: absPath });
    },
    async toMarkdown(file) {
      // Save the file to a temp location via Tauri, then convert. The
      // current `convert_file_to_markdown` Tauri command takes a path; the
      // Svelte UI receives a File from a drag/drop or picker. To bridge,
      // we write the file to a temp path first, then delete the temp file
      // in a finally block so converting many files in a session doesn't
      // accumulate orphans in the OS temp dir.
      const { absPath, relPath } = await fileToTempPath(file);
      try {
        return await invoke<string>("convert_file_to_markdown", {
          filePath: absPath,
        });
      } finally {
        try {
          await remove(relPath, { baseDir: BaseDirectory.Temp });
        } catch (e) {
          console.warn("[platform] temp file cleanup failed:", e);
        }
      }
    },
  },
  resolvePath: (path) => invoke("resolve_path", { path }),
  openExternal: (url) => openUrl(url),
  updater: {
    getVersion: () => tauriGetVersion(),
    async check() {
      const update = await tauriUpdaterCheck();
      if (!update) return null;
      return wrapUpdate(update);
    },
    relaunch: () => tauriRelaunch(),
  },
  fs: {
    readFile: (path) => tauriReadFile(path),
    writeFile: (path, bytes) => tauriWriteFile(path, bytes),
    remove: (path) => remove(path),
    tempDir: () => tauriTempDir(),
    join: (...segments) => tauriJoin(...segments),
  },
  dialog: {
    async openFilePicker(opts) {
      const picked = await openDialog({
        multiple: opts?.multiple ?? false,
        filters: opts?.filters,
      });
      if (picked === null) return [];
      return Array.isArray(picked) ? picked : [picked];
    },
  },
  cursor: {
    getPosition: () => cursorPosition(),
    setClickthrough: (enabled) => getCurrentWindow().setIgnoreCursorEvents(enabled),
  },
  menu: {
    async showContextMenu(items: ContextMenuItem[]) {
      // Tauri's Menu fires per-item actions; we resolve the returned
      // promise with the chosen id (or null on dismiss). Separators
      // pass through as `{ item: "Separator" }` in the underlying API.
      let resolved: ((id: string | null) => void) | null = null;
      const result = new Promise<string | null>((resolve) => {
        resolved = resolve;
      });
      const menuItems: Array<MenuItemOptions | { item: "Separator" }> = items.map((item) => {
        if ("separator" in item) return { item: "Separator" };
        return {
          id: item.id,
          text: item.label,
          enabled: item.enabled ?? true,
          action: () => {
            if (resolved) resolved(item.id);
          },
        };
      });
      const menu = await Menu.new({ items: menuItems });
      await menu.popup();
      // popup() resolves immediately on click OR on dismiss. We can't
      // distinguish — so race the action-driven resolve with a microtask
      // timeout that returns null if no item fired.
      const dismissTimer = setTimeout(() => {
        if (resolved) resolved(null);
      }, 0);
      try {
        return await result;
      } finally {
        clearTimeout(dismissTimer);
      }
    },
  },
  monitors: {
    async primary() {
      const m = await tauriPrimaryMonitor();
      return m ? toMonitorInfo(m, true) : null;
    },
    async available() {
      const list = await tauriAvailableMonitors();
      const primary = await tauriPrimaryMonitor();
      return list.map((m) => toMonitorInfo(m, primary?.name === m.name));
    },
  },
};

function wrapUpdate(update: Update): UpdateHandle {
  return {
    version: update.version,
    notes: update.body ?? undefined,
    async downloadAndInstall(onProgress) {
      await update.downloadAndInstall((event) => {
        if (!onProgress) return;
        if (event.event === "Started") {
          onProgress({ kind: "Started", total: event.data.contentLength });
        } else if (event.event === "Progress") {
          onProgress({ kind: "Progress", chunk: event.data.chunkLength });
        } else if (event.event === "Finished") {
          onProgress({ kind: "Finished" });
        }
      });
    },
    close: () => update.close(),
  };
}

function toMonitorInfo(m: TauriMonitor, isPrimary: boolean): MonitorInfo {
  return {
    id: m.name ?? `${m.position.x},${m.position.y}`,
    name: m.name ?? "unnamed",
    isPrimary,
    x: m.position.x,
    y: m.position.y,
    width: m.size.width,
    height: m.size.height,
  };
}

// Tauri command for file-to-markdown takes a path. The Svelte File object
// doesn't expose its on-disk path (it's a Blob). Solution: write the bytes
// to a Tauri-managed temp file via tauri-plugin-fs, then pass that path.
// Returns both forms so the caller can both invoke the command (needs the
// absolute path, since the convert command runs outside the FS-plugin sandbox)
// and clean up afterwards (the remove() API takes the relative path + base).
async function fileToTempPath(file: File): Promise<{ absPath: string; relPath: string }> {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const relPath = `tomat-tmp-${Date.now()}-${safe}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await tauriWriteFile(relPath, bytes, { baseDir: BaseDirectory.Temp });
  const absPath = await tauriJoin(await tauriTempDir(), relPath);
  return { absPath, relPath };
}
