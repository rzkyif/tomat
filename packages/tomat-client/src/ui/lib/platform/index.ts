// Platform abstraction: every host-only feature the Svelte UI uses goes
// through this interface so the same code can run under Tauri (desktop) or
// in a browser (web/mobile build) with different implementations.
//
// IMPORTANT: NOTHING under packages/tomat-client/src/ui/ outside of
// `lib/platform/` may import `@tauri-apps/*`. For components, state stores,
// and shared modules, all platform-specific calls go through `platform()`.
// This is enforced by an oxlint rule (see .oxlintrc.json). To add a new
// platform-specific feature: add the method to the `Platform` interface
// below, implement it in `tauri.ts`, stub it in `web.ts`, then call
// `platform().<namespace>.<method>()` from the consumer.

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

// --- Context menu --------------------------------------------------------

export type ContextMenuItem =
  | { id: string; label: string; enabled?: boolean; checked?: boolean }
  | { separator: true };

// --- Updater --------------------------------------------------------------

/** Per-update handle returned by `updater.check()`. The Tauri impl wraps
 *  `@tauri-apps/plugin-updater`'s `Update` class. Its `.downloadAndInstall`
 *  and `.close` are stateful, so the handle is a wrapper, not a plain
 *  value object. Callers MUST `.close()` (or call `downloadAndInstall`,
 *  which closes implicitly) to release the underlying resources. */
export interface UpdateHandle {
  /** Version available for install (semver). */
  readonly version: string;
  /** Optional changelog / release notes from the manifest. */
  readonly notes?: string;
  /** Run the actual download + install. Progress callback fires with
   *  per-chunk byte counts and a total when available. Resolves once the
   *  staging swap is queued; the OS-level relaunch is separate. */
  downloadAndInstall(
    onProgress?: (
      event:
        | { kind: "Started"; total?: number }
        | { kind: "Progress"; chunk: number }
        | { kind: "Finished" },
    ) => void,
  ): Promise<void>;
  /** Release the underlying handle without installing. */
  close(): Promise<void>;
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
  /** Register window-scoped shortcuts that fire only while the input
   *  surface is focused. Pass `[]` to clear. The tuples are
   *  [logical-id, accelerator]; the logical-id is what the matching
   *  `subscribeInputEvents` callback receives. */
  setInputBindings(bindings: Array<[string, string]>): Promise<void>;
  /** Subscribe to the window-scoped input shortcuts registered via
   *  `setInputBindings`. The Rust side emits per-id events; we expose a
   *  typed handler bundle for the three logical actions the UI cares
   *  about today. Returns a cleanup detach. */
  subscribeInputEvents(handlers: {
    onAttachFile?: () => void;
    onCaptureScreen?: () => void;
    onCaptureRegion?: () => void;
  }): Promise<() => void>;
}

// --- Networking ----------------------------------------------------------
//
// All traffic to a paired core goes through `platform().net`, which terminates
// TLS with CERTIFICATE PINNING below the webview (browser fetch/WebSocket can't
// pin a self-signed cert). The desktop impl does it in Rust (reqwest +
// tokio-tungstenite + a custom rustls verifier on the SPKI pin); a future mobile
// impl reuses the same Rust; the web stub falls back to browser fetch/WebSocket
// (no pinning; relies on the browser's CA trust). `pin` is base64(SHA-256(SPKI));
// `capturePin` is the pairing-time TOFU mode that records the presented cert's
// pin instead of enforcing one.

export interface NetRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body. Binary (multipart, audio) is passed as bytes. */
  body?: string | Uint8Array;
  /** Expected SPKI pin to enforce (base64 SHA-256). Omit with capturePin. */
  pin?: string;
  /** Pairing TOFU: accept the presented cert and return its pin (no enforce). */
  capturePin?: boolean;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** The pin the server presented, when `capturePin` was set. */
  capturedPin?: string;
}

/** A pinned WebSocket. Mirrors the slice of `WebSocket` that CoreClient uses. */
export interface NetSocket {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  /** `reason` carries the connect-failure message when available (e.g. from the
   *  Tauri WS error event), so callers can surface it instead of a generic one. */
  onError(cb: (reason?: string) => void): void;
}

/** Severity levels for the client logger (lib/shared/log.ts). */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Platform {
  // Network access to a paired core, with TLS certificate pinning enforced
  // below the webview. See the NetRequest/NetSocket docs above.
  net: {
    fetch(req: NetRequest): Promise<NetResponse>;
    connectWebSocket(url: string, opts?: { pin?: string }): Promise<NetSocket>;
  };
  // Window control.
  windowing: {
    show(): Promise<void>;
    hide(): Promise<void>;
    toggle(): Promise<void>;
    requestHide(): Promise<void>;
    position(args: {
      monitorId?: string;
      alignment?: "left" | "center" | "right";
      /** Optional logical-pixel width to apply along with the position. */
      width?: number;
    }): Promise<void>;
    /** True when the main window is currently shown. */
    isVisible(): Promise<boolean>;
    /** Subscribe to main-window visibility transitions. The callback fires
     *  whenever the window shows or hides (driven by Rust's tray / hotkey
     *  handlers, not just the JS-driven show/hide calls). */
    subscribeVisibility(cb: (visible: boolean) => void): Promise<() => void>;
    /** Read the main window's current outer size in physical pixels. */
    outerSize(): Promise<{ width: number; height: number }>;
    /** Read the main window's current outer position in physical pixels
     *  relative to the primary monitor origin. */
    outerPosition(): Promise<{ x: number; y: number }>;
    /** Set the main window's size in physical pixels. */
    setOuterSize(size: { width: number; height: number }): Promise<void>;
    /** Set the main window's position in physical pixels. */
    setOuterPosition(pos: { x: number; y: number }): Promise<void>;
    /** Read the monitor the main window is currently positioned on. */
    currentMonitor(): Promise<MonitorInfo | null>;
    /** Subscribe to Rust-originated "hide me" requests (tray click,
     *  hotkey, etc.). Returns a detach. */
    subscribeHideRequested(cb: () => void): Promise<() => void>;
    /** Subscribe to the monitor-arrangement-changed event (DPI/scale
     *  change, monitor plugged/unplugged). Returns a detach. */
    subscribeMonitorChanged(cb: () => void): Promise<() => void>;
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
    /** Runs the platform install script and returns the printed pairing code.
     *  `service: true` (default) registers a launchd / systemd / scheduled
     *  task so the core boots on login; `false` skips that and expects the
     *  client to spawn the core on demand. `bindAll: true` seeds the new
     *  core's settings.json with `server.bindHost: "0.0.0.0"` so it listens on
     *  all interfaces from the very first boot (changeable later in Settings). */
    installLocalCore(opts?: { service?: boolean; bindAll?: boolean }): Promise<string>;
    /** Whether ~/.tomat/core/bin/tomat-core exists. Used at boot to decide
     *  whether we should attempt to spawn the local core for on-demand mode. */
    isLocalCoreInstalled(): Promise<boolean>;
    /** Spawn ~/.tomat/core/bin/tomat-core detached if the loopback core isn't
     *  already responding. Returns `true` when a new process was started. */
    startLocalCore(): Promise<boolean>;
    /** Loopback base URL of this channel's local core, with the channel-aware
     *  port (stable 7800, beta 7810, …). Used by the "on this computer"
     *  pair/install flow so a beta client targets the beta core. */
    localCoreBaseUrl(): Promise<string>;
    /** This channel's default local sidecar ports (llama / whisper). Used as
     *  fallbacks when the paired core hasn't overridden llm.port / stt.port so
     *  a beta client talks to the beta sidecars (7711/7712), not stable's. */
    localSidecarPorts(): Promise<{ llm: number; stt: number }>;
    /** Optional `--core-url` / `--pairing-code` launch arguments, used to
     *  prefill the "On another computer" onboarding fields. Doubles as a
     *  shareable setup command; `deno task dev` passes the dev core URL + code
     *  this way. Returns null when neither flag was given (or on web). */
    launchPrefill(): Promise<{ coreUrl?: string; pairingCode?: string } | null>;
  };
  // File-to-markdown conversion (desktop uses Rust crates; web uses core fallback).
  fileConvert: {
    toMarkdown(file: File): Promise<string>;
    /** Convert a file already on disk by absolute path. Used by the paste
     *  / dialog-pick flows which produce a path directly without going
     *  through a Blob roundtrip. */
    toMarkdownFromPath(absPath: string): Promise<string>;
  };
  // Path expansion (~ → home).
  resolvePath(path: string): Promise<string>;
  // Default Downloads folder.
  openExternal(url: string): Promise<void>;
  // Tauri auto-updater. Wraps @tauri-apps/plugin-updater so UpdateButton
  // doesn't have to import the plugin directly.
  updater: {
    /** Current installed version (from Tauri's app metadata). */
    getVersion(): Promise<string>;
    /** Check the configured update endpoint. Returns null when no update
     *  is available; otherwise an UpdateHandle the caller drives. */
    check(): Promise<UpdateHandle | null>;
    /** Relaunch the desktop client process. */
    relaunch(): Promise<void>;
  };
  // Filesystem ops needed by drag-drop / attachment flows. Async across the
  // board to match Tauri's plugin shape and to keep the web stub uniform.
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, bytes: Uint8Array): Promise<void>;
    remove(path: string): Promise<void>;
    tempDir(): Promise<string>;
    join(...segments: string[]): Promise<string>;
  };
  // Native file-picker dialog. Returns absolute paths chosen by the user,
  // or an empty array on cancel.
  dialog: {
    openFilePicker(opts?: {
      multiple?: boolean;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string[]>;
  };
  // Cursor introspection + click-through toggling for the floating window.
  // Used by lib/shared/clickthrough.ts to make the transparent regions of
  // the bubble window pass mouse events to whatever's behind.
  cursor: {
    /** Current cursor position in physical pixels relative to the primary
     *  monitor origin. */
    getPosition(): Promise<{ x: number; y: number }>;
    /** Toggle click-through on the main window. When true, mouse events
     *  pass through transparent pixels to the desktop. */
    setClickthrough(enabled: boolean): Promise<void>;
  };
  // Native context menu, used for right-click message actions where the
  // browser menu would obscure the UI.
  menu: {
    /** Show a context menu at the current cursor and resolve with the
     *  id of the chosen item, or null if dismissed. Separator entries
     *  carry no id and are skipped when matching the resolved value. */
    showContextMenu(items: ContextMenuItem[]): Promise<string | null>;
  };
  // Monitor enumeration shared between Settings (pick a monitor) and the
  // window-position math. Distinct from `capture.monitors` (xcap-based,
  // used by the screen-capture path). These come from Tauri's window
  // module and align with `windowing.position`.
  monitors: {
    primary(): Promise<MonitorInfo | null>;
    available(): Promise<MonitorInfo[]>;
  };
  // Structured logging routed to the Rust backend so lines reach the dev
  // terminal and the persisted client.log (WARN/ERROR only). Callers use
  // getLogger(scope) from lib/shared/log.ts, not this directly.
  logging: {
    /** Fire-and-forget. `message` is already fully formatted; `scope` is passed
     *  separately so the backend can render it as the module column. */
    log(level: LogLevel, scope: string, message: string): void;
  };
}

let _impl: Platform | null = null;

export function setPlatform(p: Platform): void {
  _impl = p;
}

export function platform(): Platform {
  if (!_impl) throw new Error("platform() called before setPlatform()");
  return _impl;
}
