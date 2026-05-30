// Browser implementation of the Platform interface. Most desktop-only
// surfaces no-op gracefully; pairing-token storage uses localStorage with
// a clear "less secure than keychain" caveat baked into the UI.

import { setPlatform, type Platform } from "./index";

export function installWebPlatform(): void {
  setPlatform(impl);
}

const NOOP = async (): Promise<void> => {
  /* noop */
};
const STORAGE_PREFIX = "tomat:keychain:";
const CLIENT_SETTINGS_KEY = "tomat:client-settings";

const impl: Platform = {
  net: {
    // The browser does standard CA verification and exposes no certificate
    // pinning to JS, so `pin` is ignored and `capturePin` can't read the cert.
    // This means the web build CANNOT pair with a self-signed core (the PAKE
    // cert-pin binding has no pin to verify) — it only works against a core
    // with a browser-trusted (CA) cert. Documented limitation of the web build.
    async fetch(req) {
      const res = await fetch(req.url, {
        method: req.method ?? "GET",
        headers: req.headers,
        // string | Uint8Array are both valid BodyInit at runtime; the DOM lib
        // types are stricter than necessary here.
        body: req.body as BodyInit | undefined,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      const body = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, headers, body };
    },
    async connectWebSocket(url) {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      return {
        send: (d) => ws.send(d),
        close: () => ws.close(),
        onOpen: (cb) => ws.addEventListener("open", () => cb()),
        onMessage: (cb) =>
          ws.addEventListener("message", (ev) => {
            cb(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
          }),
        onClose: (cb) => ws.addEventListener("close", () => cb()),
        onError: (cb) => ws.addEventListener("error", () => cb()),
      };
    },
  },
  windowing: {
    show: NOOP,
    hide: NOOP,
    toggle: NOOP,
    requestHide: NOOP,
    position: () => Promise.resolve(),
    isVisible: async () => true,
    subscribeVisibility: async () => () => {
      /* never fires in web mode */
    },
    outerSize: async () => ({ width: window.innerWidth, height: window.innerHeight }),
    outerPosition: async () => ({ x: window.screenX, y: window.screenY }),
    setOuterSize: () => Promise.reject(new Error("setOuterSize not available in browser build")),
    setOuterPosition: () =>
      Promise.reject(new Error("setOuterPosition not available in browser build")),
    currentMonitor: async () => null,
    subscribeHideRequested: async () => () => {
      /* no Rust event source in browser */
    },
    subscribeMonitorChanged: async () => () => {
      /* no Rust event source in browser */
    },
  },
  capture: {
    monitors: async () => [],
    captureMonitor: () => Promise.reject(new Error("capture not available in browser")),
    setRegionTarget: NOOP,
    getRegionTarget: async () => "primary",
    showRegionOverlay: async () => "primary",
    hideRegionOverlay: NOOP,
    subscribeRegionResult: async () => () => {
      /* never fires in web mode */
    },
  },
  audio: {
    getSystemVolume: async () => 100,
    setSystemVolume: NOOP,
    restoreSystemVolume: NOOP,
  },
  fonts: {
    list: async () => [],
  },
  shortcuts: {
    // Browsers can't register OS-level global shortcuts. UI should hide the
    // relevant settings groups when running in web mode.
    setBinding: NOOP,
    validate: async () => {
      /* always ok */
    },
    subscribeEvents: async () => () => {
      /* never fires in web mode */
    },
    setInputBindings: NOOP,
    subscribeInputEvents: async () => () => {
      /* never fires in web mode */
    },
  },
  clientSettings: {
    async read() {
      try {
        const raw = localStorage.getItem(CLIENT_SETTINGS_KEY);
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    },
    async write(settings) {
      localStorage.setItem(CLIENT_SETTINGS_KEY, JSON.stringify(settings));
    },
  },
  keychain: {
    async set(coreId, token) {
      localStorage.setItem(STORAGE_PREFIX + coreId, token);
    },
    async get(coreId) {
      return localStorage.getItem(STORAGE_PREFIX + coreId);
    },
    async delete(coreId) {
      localStorage.removeItem(STORAGE_PREFIX + coreId);
    },
  },
  pairing: {
    async readAdminToken() {
      // Browser can't read host's ~/.tomat/core/.admin-token; the user has
      // to paste the pairing code printed at install time.
      return null;
    },
    installLocalCore(_opts?: { service?: boolean; bindAll?: boolean }) {
      return Promise.reject(new Error("local install not available in browser"));
    },
    isLocalCoreInstalled() {
      return Promise.resolve(false);
    },
    startLocalCore() {
      return Promise.resolve(false);
    },
    localCoreBaseUrl() {
      // Web has no local core; return the stable default for display only.
      return Promise.resolve("https://127.0.0.1:7800");
    },
    localSidecarPorts() {
      return Promise.resolve({ llm: 7701, stt: 7702 });
    },
  },
  fileConvert: {
    async toMarkdown() {
      // Web build would POST to a /api/v1/attachments/convert endpoint on
      // the paired core. Not implemented yet.
      throw new Error("file conversion not available in browser build");
    },
    async toMarkdownFromPath() {
      throw new Error("file conversion not available in browser build");
    },
  },
  resolvePath: async (path) => path,
  openExternal: async (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  updater: {
    async getVersion() {
      // Web build has no `app.getVersion()` analogue; the bundle's version
      // belongs to the deploy, not the browser. UI can hide the chip.
      return "web";
    },
    async check() {
      // No auto-updater in the browser — deployments are the update path.
      return null;
    },
    relaunch: () => Promise.reject(new Error("relaunch not available in browser build")),
  },
  fs: {
    readFile: () => Promise.reject(new Error("fs.readFile not available in browser build")),
    writeFile: () => Promise.reject(new Error("fs.writeFile not available in browser build")),
    remove: () => Promise.reject(new Error("fs.remove not available in browser build")),
    tempDir: () => Promise.reject(new Error("fs.tempDir not available in browser build")),
    // join() is a pure-string utility, so we can implement it without
    // needing real disk access. Useful for any caller that only joins
    // pre-derived path fragments.
    async join(...segments) {
      return segments
        .filter((s) => s.length > 0)
        .map((s, i) => (i === 0 ? s.replace(/\/+$/, "") : s.replace(/^\/+|\/+$/g, "")))
        .join("/");
    },
  },
  dialog: {
    openFilePicker: () =>
      Promise.reject(new Error("native file picker not available in browser build")),
  },
  cursor: {
    getPosition: () =>
      Promise.reject(new Error("cursor.getPosition not available in browser build")),
    setClickthrough: NOOP,
  },
  menu: {
    showContextMenu: () =>
      Promise.reject(new Error("native context menu not available in browser build")),
  },
  monitors: {
    primary: async () => null,
    available: async () => [],
  },
};
