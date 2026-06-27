// Android (Tauri-mobile) implementation of the Platform interface. Like
// tauri.ts it runs inside a Tauri webview and may import `@tauri-apps/*`
// (the no-tauri-import rule only restricts code outside lib/platform/).
//
// Reuse vs. not-supported: the namespaces that call cross-platform Rust
// commands (net, client files, storage, keychain, process, logging,
// resolvePath) or cross-platform plugins (fs, dialog, opener, app version)
// are identical to desktop. The desktop-only host features (windowing,
// global shortcuts, screen capture, system-volume ducking, autostart, native
// menus, local-core install) are stubbed: they either no-op or reject with a
// clear "not supported on mobile" error, and the UI hides their affordances
// behind UiContext.platform === "mobile". See the capability matrix in the
// Android plan and the per-feature notes inline.

import { invoke } from "@tauri-apps/api/core";
import {
  getVersion as tauriGetVersion,
  hide as tauriHide,
  onBackButtonPress,
} from "@tauri-apps/api/app";
import { join as tauriJoin, tempDir as tauriTempDir } from "@tauri-apps/api/path";
import {
  readFile as tauriReadFile,
  remove,
  writeFile as tauriWriteFile,
} from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { sha256Hex, timingSafeEqualHex, verifyEd25519Detached } from "@tomat/shared";
import { presentActionSheet } from "$lib/menu/action-sheet-host.svelte";
import { type Platform, setPlatform, type UpdateHandle } from "./index";
import { net } from "./shared";

export function installMobilePlatform(): void {
  setPlatform(impl);
}

// --- Self-hosted APK updater ----------------------------------------------
//
// Tauri's updater plugin has no Android support, so mobile self-updates are
// checked against the same R2-hosted, Ed25519-signed manifest the release
// pipeline publishes (scripts/release/android.ts -> android.json). The manifest
// is fetched over an unpinned connection, so before ANY field is trusted its
// detached signature (android.json.sig) is verified against the committed
// signing key, and the downloaded APK is checked against the signed sha256
// before it is staged for install. Without those two checks this would be an
// unauthenticated fetch-and-install path. The keystore signature Android
// enforces at install time is a final backstop, not the trust gate.
//
// Ed25519 signing public key: the trust root for release manifests. Mirrors the
// value in packages/tomat-core/data/signing-keys.json (baked into every compiled
// core). If the signing key is ever rotated, update it here too.
const ANDROID_MANIFEST_PUBKEY = "KghrHOIqu76Hpl/xX8RHUuDA2n1NGCOj9gD1Jrn5H+M=";

interface AndroidManifest {
  version: string;
  notes?: string;
  abis: Record<string, { url: string; sha256: string }>;
}

/** The android.json URL for the channel baked into this build. Stable lives at
 *  /manifests; other channels nest under /manifests/<channel>/, matching the
 *  release pipeline (channelManifestDir) and the per-channel applicationId, so a
 *  non-stable install updates from its own manifest rather than stable's. */
async function androidManifestUrl(): Promise<string> {
  let channel = "stable";
  try {
    channel = (await invoke<string>("client_channel")) || "stable";
  } catch {
    // Fall back to stable if the command is unavailable.
  }
  const dir = channel === "stable" ? "manifests" : `manifests/${channel}`;
  return `https://get.au.tomat.ing/${dir}/android.json`;
}

/** Strictly-greater semver compare. Numeric major.minor.patch first; on a tie a
 *  release (no pre-release suffix) outranks a pre-release, and two pre-releases
 *  fall back to lexical order. Avoids `parseInt("0-rc1")` swallowing suffixes. */
function isNewerVersion(remote: string, local: string): boolean {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const dash = v.indexOf("-");
    const core = dash === -1 ? v : v.slice(0, dash);
    const pre = dash === -1 ? "" : v.slice(dash + 1);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
  };
  const r = parse(remote);
  const l = parse(local);
  for (let i = 0; i < Math.max(r.nums.length, l.nums.length); i++) {
    const a = r.nums[i] ?? 0;
    const b = l.nums[i] ?? 0;
    if (a !== b) return a > b;
  }
  if (r.pre === l.pre) return false;
  if (!r.pre) return true; // remote is a release, local a pre-release
  if (!l.pre) return false; // remote is a pre-release, local a release
  return r.pre > l.pre;
}

async function checkAndroidUpdate(): Promise<UpdateHandle | null> {
  const current = await tauriGetVersion();
  const manifestUrl = await androidManifestUrl();
  let rawBytes: Uint8Array;
  let signature: string;
  try {
    const [mRes, sRes] = await Promise.all([
      fetch(manifestUrl, { cache: "no-store" }),
      fetch(`${manifestUrl}.sig`, { cache: "no-store" }),
    ]);
    if (!mRes.ok || !sRes.ok) return null;
    rawBytes = new Uint8Array(await mRes.arrayBuffer());
    signature = (await sRes.text()).trim();
  } catch {
    return null;
  }
  // Authenticate the EXACT manifest bytes (the signature is over the raw file)
  // before trusting any version, url, or hash inside it.
  if (!verifyEd25519Detached(ANDROID_MANIFEST_PUBKEY, signature, rawBytes)) return null;

  let manifest: AndroidManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(rawBytes)) as AndroidManifest;
  } catch {
    return null;
  }
  if (!manifest?.version || !isNewerVersion(manifest.version, current)) return null;
  // The device ABI isn't known to JS; prefer arm64 (every modern device), then a
  // universal fat APK, then whatever the manifest carries.
  const entry =
    manifest.abis["android-arm64"] ??
    manifest.abis["android-universal"] ??
    Object.values(manifest.abis ?? {})[0];
  if (!entry?.url || !entry?.sha256) return null;
  const expectedSha = entry.sha256.toLowerCase();

  return {
    version: manifest.version,
    notes: manifest.notes,
    async downloadAndInstall(onProgress) {
      const res = await fetch(entry.url);
      if (!res.ok || !res.body) throw new Error(`APK download failed: ${res.status}`);
      const total = Number(res.headers.get("content-length")) || undefined;
      onProgress?.({ kind: "Started", total });
      // Stream the APK, reporting real per-chunk progress instead of buffering
      // silently and emitting one synthetic event.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress?.({ kind: "Progress", chunk: value.length });
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      // Verify the download against the signed manifest's hash before staging.
      const digest = await sha256Hex(bytes);
      if (!timingSafeEqualHex(digest, expectedSha)) {
        throw new Error("downloaded APK does not match the signed manifest hash");
      }
      const path = `${await tauriTempDir()}/tomat-${manifest.version}.apk`;
      await tauriWriteFile(path, bytes);
      onProgress?.({ kind: "Finished" });
      // Opening the APK hands off to Android's package installer (needs the
      // REQUEST_INSTALL_PACKAGES permission); the user confirms the install.
      await openPath(path);
    },
    close: () => Promise.resolve(),
  };
}

/** Reject for a host feature that genuinely has no Android equivalent. The UI
 *  gates these affordances on `UiContext.platform`, so a thrown error here is a
 *  belt-and-suspenders guard, not an expected path. */
function notSupported(feature: string): Promise<never> {
  return Promise.reject(new Error(`${feature} is not supported on mobile`));
}

/** A subscription stub that never fires, returning an inert detach. Used for
 *  desktop-only event streams (tray/hotkey/monitor changes). */
async function inertSubscription(): Promise<() => void> {
  return () => {};
}

const impl: Platform = {
  // Pinned HTTP + WebSocket to a paired core; shared with the desktop impl
  // since both call the same Rust commands (see lib/platform/shared.ts). LAN
  // discovery is desktop-only (the Rust command isn't registered on mobile and
  // interface enumeration is out of scope), so override it with an empty sweep.
  net: { ...net, discoverCores: () => Promise.resolve([]) },
  windowing: {
    // A single fullscreen activity: there is no floating window to move, size,
    // or hide. show/hide/position resolve as no-ops so the boot path (which
    // positions + shows the desktop bubble) proceeds unchanged.
    show: () => Promise.resolve(),
    hide: () => Promise.resolve(),
    toggle: () => Promise.resolve(),
    requestHide: () => Promise.resolve(),
    position: () => Promise.resolve(),
    isVisible: () => Promise.resolve(true),
    async subscribeVisibility(cb) {
      // Map foreground/background to the WebView's document visibility so
      // foreground-gated work (e.g. VAD) can pause when the app is backgrounded.
      const handler = () => cb(document.visibilityState === "visible");
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
    outerSize: () => Promise.resolve({ width: 0, height: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    setOuterSize: () => Promise.resolve(),
    setOuterPosition: () => Promise.resolve(),
    currentMonitor: () => Promise.resolve(null),
    subscribeHideRequested: inertSubscription,
    subscribeMonitorChanged: inertSubscription,
  },
  backButton: {
    // Tauri's app plugin emits a `back-button` event for every Android system
    // back press (TauriActivity ships handleBackNavigation=false, so the JS
    // layer owns back). The back-handler registry decides what each press does.
    async subscribe(cb) {
      const listener = await onBackButtonPress(() => cb());
      return () => void listener.unregister();
    },
    // Leave the app on the final root double-back. app.hide() is the only
    // exit/background path that needs no extra plugin or capability (the process
    // plugin has no Android support); if it proves to no-op on the target OS,
    // swap this for a moveTaskToBack hook in MainActivity. Best-effort: never
    // throw out of a back-button handler.
    async exit() {
      try {
        await tauriHide();
      } catch {
        // No-op: a failed background must not crash the back handler.
      }
    },
  },
  autostart: {
    isEnabled: () => Promise.resolve(false),
    setEnabled: () => notSupported("Launch on login"),
    wasAutostarted: () => Promise.resolve(false),
  },
  capture: {
    // Screen capture is replaced on mobile by attaching photos/files; the
    // region-overlay flow has no mobile analogue.
    monitors: () => Promise.resolve([]),
    captureMonitor: () => notSupported("Screen capture"),
    setRegionTarget: () => Promise.resolve(),
    getRegionTarget: () => Promise.resolve("primary"),
    showRegionOverlay: () => notSupported("Region capture"),
    hideRegionOverlay: () => Promise.resolve(),
    subscribeRegionResult: inertSubscription,
  },
  audio: {
    // No app-level OS volume control on Android; VAD listens without ducking.
    getSystemVolume: () => Promise.resolve(100),
    setSystemVolume: () => Promise.resolve(),
    restoreSystemVolume: () => Promise.resolve(),
  },
  fonts: {
    // Android has no font-enumeration API exposed here, so offer a curated list
    // of families that resolve on Android (the system default plus widely
    // bundled faces) instead of an empty picker. "default" maps to the system
    // stack via the appearance settings.
    list: () =>
      Promise.resolve(["Roboto", "Noto Sans", "Noto Serif", "Droid Sans Mono", "monospace"]),
  },
  process: {
    selfMetrics: () => invoke("get_self_metrics"),
  },
  clientStorage: {
    tree: () => invoke("get_client_storage"),
    truncateActiveLog: () => invoke("truncate_client_log"),
  },
  shortcuts: {
    // No OS-level global hotkeys or window-scoped accelerators on Android; the
    // mobile UI offers on-screen buttons instead.
    setBinding: () => Promise.resolve(),
    validate: () => notSupported("Global shortcuts"),
    subscribeEvents: inertSubscription,
    setInputBindings: () => Promise.resolve(),
    subscribeInputEvents: inertSubscription,
  },
  clientFiles: {
    read: (file) => invoke("read_client_file", { file }),
    write: (file, data) => invoke("write_client_file", { file, data }),
  },
  snippetFiles: {
    readAll: () => invoke("read_client_snippets"),
    write: (name, data) => invoke("write_client_snippet", { name, data }),
    delete: (name) => invoke("delete_client_snippet", { name }),
  },
  keychain: {
    set: (coreId, token) => invoke("keychain_set_token", { coreId, token }),
    get: (coreId) => invoke("keychain_get_token", { coreId }),
    delete: (coreId) => invoke("keychain_delete_token", { coreId }),
  },
  pairing: {
    // Remote-only on mobile: no on-device core install/spawn. These resolve to
    // inert values so the (desktop-shaped) onboarding never throws before the
    // mobile NewCore flow drops the local branch entirely.
    readAdminToken: () => Promise.resolve(null),
    readLocalCoreBootError: () => Promise.resolve(null),
    installLocalCore: () => notSupported("Installing a local Core"),
    isLocalCoreInstalled: () => Promise.resolve(false),
    startLocalCore: () => Promise.resolve(false),
    localCoreBaseUrl: () => Promise.resolve(""),
    localSidecarPorts: () => Promise.resolve({ llm: 0, stt: 0 }),
    // Dev-only onboarding autofill, the mobile analogue of the desktop
    // `--core-url` / `--pairing-code` launch arguments (which a mobile build has
    // no argv to receive). `deno task dev:android` exports both as Vite env vars
    // baked into this dev bundle: VITE_DEV_CORE_URL points at the host core on
    // the device-reachable address (emulator 10.0.2.2 or TAURI_DEV_HOST for a
    // physical device), and VITE_DEV_PAIRING_CODE carries the code it minted.
    // Falls back to deriving the address from the dev-server host (location) on
    // the channel's core port (stable 7800, latest 7810, dev 7820) when the URL
    // env is absent. Both fields are only prefilled, never locked.
    launchPrefill: async () => {
      if (!import.meta.env.DEV) return null;
      const pairingCode = (import.meta.env.VITE_DEV_PAIRING_CODE as string | undefined)?.trim();
      const coreUrlEnv = (import.meta.env.VITE_DEV_CORE_URL as string | undefined)?.trim();
      if (coreUrlEnv) {
        return { coreUrl: coreUrlEnv, pairingCode: pairingCode || undefined };
      }
      const host = globalThis.location?.hostname;
      if (!host) return null;
      let channel = "stable";
      try {
        channel = (await invoke<string>("client_channel")) || "stable";
      } catch {
        /* default to the stable port */
      }
      const port = 7800 + (channel === "dev" ? 20 : channel === "latest" ? 10 : 0);
      return { coreUrl: `https://${host}:${port}`, pairingCode: pairingCode || undefined };
    },
  },
  fileConvert: {
    // File-to-markdown uses desktop-only Rust crates; mobile attachments are
    // wired through the core in a later pass.
    toMarkdown: () => notSupported("File conversion"),
    toMarkdownFromPath: () => notSupported("File conversion"),
  },
  resolvePath: (path) => invoke("resolve_path", { path }),
  openExternal: (url) => openUrl(url),
  // No OS file-manager reveal on Android; treat as a no-op (callers already
  // gate the affordance on same-device availability).
  revealPath: () => Promise.resolve(),
  updater: {
    getVersion: () => tauriGetVersion(),
    // Self-hosted: compares the app version against the R2-hosted android.json
    // and hands a newer APK to Android's package installer (see above).
    check: () => checkAndroidUpdate(),
    // No process relaunch on Android: the package installer restarts the app.
    relaunch: () => notSupported("Relaunch"),
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
      // The Android dialog plugin returns content URIs rather than absolute
      // paths; attachment ingestion routes those through bytes, not paths.
      const picked = await openDialog({
        multiple: opts?.multiple ?? false,
        filters: opts?.filters,
      });
      if (picked === null) return [];
      return Array.isArray(picked) ? picked : [picked];
    },
  },
  cursor: {
    // No pointer on touch; the bubble click-through machinery is gated off.
    getPosition: () => Promise.resolve({ x: 0, y: 0 }),
    setClickthrough: () => Promise.resolve(),
  },
  menu: {
    // Native desktop context menus are replaced by an in-app action sheet. The
    // existing menu builders call this with the same items; the host renders a
    // shared ActionSheet and resolves with the chosen id, so every context menu
    // works on touch once a long-press trigger invokes its builder.
    showContextMenu: (items) => presentActionSheet(items),
  },
  monitors: {
    primary: () => Promise.resolve(null),
    available: () => Promise.resolve([]),
  },
  logging: {
    log(level, scope, message) {
      void invoke("client_log", { level, scope, message }).catch(() => {});
    },
  },
};
