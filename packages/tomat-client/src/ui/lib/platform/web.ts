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
    installLocalCore() {
      return Promise.reject(new Error("local install not available in browser"));
    },
  },
  fileConvert: {
    async toMarkdown() {
      // Web build would POST to a /api/v1/attachments/convert endpoint on
      // the paired core. Not implemented yet.
      throw new Error("file conversion not available in browser build");
    },
  },
  resolvePath: async (path) => path,
  openExternal: async (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};
