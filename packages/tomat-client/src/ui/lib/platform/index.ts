// Platform abstraction: every host-only feature the Svelte UI uses goes
// through this interface so the same code can run under Tauri (desktop) or
// in a browser (web/mobile build) with different implementations.
//
// IMPORTANT: nothing under lib/state/ or lib/shared/ should import directly
// from `@tauri-apps/*`. Route platform-specific calls through `platform()`
// so the web/mobile stub can intercept them. Components under
// lib/components/ that own a Tauri-only feature (region-capture overlay,
// drag-drop file paths) currently still call invoke directly; gate those
// on `isTauri()` and add a platform method when porting to web.

// Mirrors the Rust `list_capture_monitors` return shape so the
// `lib/shared/capture.ts` flow can cast without information loss. Physical
// pixel bounds (x, y, width, height) let the region-capture flow match the
// active monitor against Tauri's `currentMonitor()` position without
// relying on names matching.
export interface MonitorInfo {
  id: string;
  name: string;
  isPrimary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShortcutBindings {
  /** Set or clear the OS-level global shortcut binding. Passing null
   *  unregisters whatever accelerator was previously bound. */
  setBinding(accelerator: string | null): Promise<void>;
  /** Probe whether an accelerator can be registered without actually keeping
   *  it. Used by the Settings UI to surface "already taken" before persist. */
  validate(accelerator: string): Promise<void>;
  /** Subscribe to press/release events from the currently-bound shortcut.
   *  Returns a cleanup function that detaches both listeners. */
  subscribeEvents(handlers: {
    onPressed: () => void;
    onReleased?: () => void;
  }): Promise<() => void>;
}

export interface Platform {
  // Window control.
  windowing: {
    show(): Promise<void>;
    hide(): Promise<void>;
    toggle(): Promise<void>;
    requestHide(): Promise<void>;
    position(args: { monitorId?: string; alignment?: "left" | "center" | "right" }): Promise<void>;
    /** True when the main window is currently shown. */
    isVisible(): Promise<boolean>;
    /** Subscribe to main-window visibility transitions. The callback fires
     *  whenever the window shows or hides (driven by Rust's tray / hotkey
     *  handlers, not just the JS-driven show/hide calls). */
    subscribeVisibility(cb: (visible: boolean) => void): Promise<() => void>;
  };
  // Screen capture. Region capture goes through `showRegionOverlay` + a Rust
  // event (the overlay window draws the selection and emits the cropped PNG);
  // there is no direct "capture a region" platform call.
  capture: {
    monitors(): Promise<MonitorInfo[]>;
    captureMonitor(monitorId: string): Promise<string>; // base64 PNG
    setRegionTarget(monitorId: string): Promise<void>;
    getRegionTarget(): Promise<string>;
    showRegionOverlay(): Promise<string>; // returns xcap monitor id
    hideRegionOverlay(): Promise<void>;
    /** Subscribe to the overlay's result event. `payload` is base64 PNG on
     *  successful drag, null on ESC / cancel. */
    subscribeRegionResult(cb: (payload: string | null) => void): Promise<() => void>;
  };
  // System audio.
  audio: {
    getSystemVolume(): Promise<number>;
    setSystemVolume(percent: number): Promise<void>;
    restoreSystemVolume(): Promise<void>;
  };
  // Installed fonts.
  fonts: { list(): Promise<string[]> };
  // Global / input shortcuts.
  shortcuts: ShortcutBindings;
  // Client-only settings file at ~/.tomat/client/settings.json.
  clientSettings: {
    read(): Promise<Record<string, unknown>>;
    write(settings: Record<string, unknown>): Promise<void>;
  };
  // OS keychain for paired-core bearer tokens.
  keychain: {
    set(coreId: string, token: string): Promise<void>;
    get(coreId: string): Promise<string | null>;
    delete(coreId: string): Promise<void>;
  };
  // Pairing helpers.
  pairing: {
    readAdminToken(): Promise<string | null>;
    installLocalCore(): Promise<string>; // returns the printed pairing code
  };
  // File-to-markdown conversion (desktop uses Rust crates; web uses core fallback).
  fileConvert: {
    toMarkdown(file: File): Promise<string>;
  };
  // Path expansion (~ → home).
  resolvePath(path: string): Promise<string>;
  // Default Downloads folder.
  openExternal(url: string): Promise<void>;
}

let _impl: Platform | null = null;

export function setPlatform(p: Platform): void {
  _impl = p;
}

export function platform(): Platform {
  if (!_impl) throw new Error("platform() called before setPlatform()");
  return _impl;
}
