// Tauri implementation of the Platform interface. The only file outside of
// itself that may import `@tauri-apps/*`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setPlatform, type Platform } from "./index";

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
    installLocalCore: () => invoke("install_local_core"),
  },
  fileConvert: {
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
};

// Tauri command for file-to-markdown takes a path. The Svelte File object
// doesn't expose its on-disk path (it's a Blob). Solution: write the bytes
// to a Tauri-managed temp file via tauri-plugin-fs, then pass that path.
// Returns both forms so the caller can both invoke the command (needs the
// absolute path, since the convert command runs outside the FS-plugin sandbox)
// and clean up afterwards (the remove() API takes the relative path + base).
import { BaseDirectory, remove, writeFile } from "@tauri-apps/plugin-fs";
async function fileToTempPath(file: File): Promise<{ absPath: string; relPath: string }> {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const relPath = `tomat-tmp-${Date.now()}-${safe}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await writeFile(relPath, bytes, { baseDir: BaseDirectory.Temp });
  const { join, tempDir } = await import("@tauri-apps/api/path");
  const absPath = await join(await tempDir(), relPath);
  return { absPath, relPath };
}
