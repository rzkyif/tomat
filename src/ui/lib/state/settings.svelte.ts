/**
 * Reactive store for user settings. Loads them from the right place on
 * startup (Rust backend on desktop, localStorage in the browser), saves
 * them back when the user changes anything, and triggers the right side
 * effect (like restarting a sidecar or toggling TTS) when the relevant
 * keys change.
 */

import { browser, dev } from "$app/environment";
import { isTauri } from "$lib/shared/env";
import { getDefaultSettings, isValidSettingKey, SECRET_KEYS } from "$lib/shared/settings";
import type { Alignment } from "$lib/shared/types";
import { invoke } from "@tauri-apps/api/core";

function warnIfUnknownKey(key: string): void {
  if (dev && !isValidSettingKey(key)) {
    console.warn(`[settings] writing unknown setting key: "${key}"`);
  }
}

class SettingsState {
  currentSettings = $state<Record<string, any>>(getDefaultSettings());

  private restartTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private saveChain: Promise<void> = Promise.resolve();

  async loadSettings() {
    if (!browser) return;
    try {
      if (isTauri()) {
        const stored = (await invoke("load_settings", { secretKeys: SECRET_KEYS })) as Record<
          string,
          any
        > | null;
        if (stored) {
          this.currentSettings = { ...getDefaultSettings(), ...stored };
        } else {
          this.currentSettings = getDefaultSettings();
          await this.save();
        }
      } else {
        const stored = localStorage.getItem("tomat-settings");
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            this.currentSettings = { ...getDefaultSettings(), ...parsed };
          } catch (e) {
            console.error("Failed to parse settings, resetting to defaults:", e);
            this.currentSettings = getDefaultSettings();
            await this.save();
          }
        }
      }
    } catch (e) {
      console.warn("Failed to load settings, using defaults:", e);
      this.currentSettings = getDefaultSettings();
    }

    // Push the persisted shortcut to Rust so it overrides the startup default.
    // Boot must not abort if the shortcut is now taken by another app: log
    // and let the user fix it from Settings.
    if (isTauri()) {
      this.applyToggleWindowShortcut(this.currentSettings["shortcuts.toggleWindow"]).catch((e) =>
        console.warn("Failed to register persisted shortcut:", e),
      );
    }
  }

  private async applyToggleWindowShortcut(value: unknown): Promise<void> {
    if (!isTauri()) return;
    const accelerator = typeof value === "string" && value.length > 0 ? value : null;
    await invoke("set_global_shortcut", { accelerator });
  }

  debounceRestart(type: "llm" | "stt") {
    const existing = this.restartTimeouts.get(type);
    if (existing) clearTimeout(existing);
    this.restartTimeouts.set(
      type,
      setTimeout(async () => {
        if (type === "llm") {
          const { messagesState } = await import("./messages.svelte");
          await messagesState.interruptStreaming();
        }
        const { restartServerIfNeed } = await import("../sidecar/manager");
        restartServerIfNeed(type);
        this.restartTimeouts.delete(type);
      }, 500),
    );
  }

  async updateSetting(key: string, value: unknown) {
    warnIfUnknownKey(key);
    const prevEnabled = !!this.currentSettings["tts.enabled"];
    const prevSttEnabled = this.currentSettings["stt.enabled"] !== false;
    const prevValue = this.currentSettings[key];
    this.currentSettings[key] = value;

    if (key === "shortcuts.toggleWindow") {
      try {
        await this.applyToggleWindowShortcut(value);
      } catch (e) {
        this.currentSettings[key] = prevValue;
        throw e;
      }
    } else if (
      isTauri() &&
      (key === "shortcuts.attachFile" ||
        key === "shortcuts.captureScreen" ||
        key === "shortcuts.captureRegion") &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      // Probe-validate the new combo before persisting. The actual
      // (re-)registration happens later when UserInput remounts; this just
      // surfaces "already taken" errors at the moment the user picks the
      // combo so the bad value doesn't get saved.
      try {
        await invoke("validate_shortcut", { accelerator: value });
      } catch (e) {
        this.currentSettings[key] = prevValue;
        throw e;
      }
    }

    await this.save();

    if (key.startsWith("llm.")) {
      this.debounceRestart("llm");
    } else if (key.startsWith("stt.")) {
      this.debounceRestart("stt");
      // If the STT enable toggle just flipped off, also stop VAD; otherwise
      // the in-browser VAD instance keeps listening and tries to transcribe
      // against a whisper-server we just shut down. Use forceDisable rather
      // than detach so the visibility listener and speech handler stay wired
      // up for a later re-enable.
      if (key === "stt.enabled" && prevSttEnabled && !value) {
        const { vadManager } = await import("$lib/shared/vad.svelte");
        void vadManager.forceDisable();
      }
    } else if (key === "tts.enabled") {
      const nowEnabled = !!value;
      if (prevEnabled !== nowEnabled) {
        const { ttsState } = await import("./tts.svelte");
        void ttsState.setEnabled(nowEnabled);
      }
    }
  }

  async updateSettings(updates: Record<string, unknown>) {
    const prevTtsEnabled = !!this.currentSettings["tts.enabled"];
    const prevShortcut = this.currentSettings["shortcuts.toggleWindow"];
    let llmChanged = false;
    let sttChanged = false;
    let ttsEnabledChanged = false;
    let toggleShortcutChanged = false;

    for (const [key, value] of Object.entries(updates)) {
      warnIfUnknownKey(key);
      this.currentSettings[key] = value;
      if (key.startsWith("llm.")) llmChanged = true;
      if (key.startsWith("stt.")) sttChanged = true;
      if (key === "tts.enabled") ttsEnabledChanged = true;
      if (key === "shortcuts.toggleWindow") toggleShortcutChanged = true;
    }

    if (toggleShortcutChanged) {
      try {
        await this.applyToggleWindowShortcut(this.currentSettings["shortcuts.toggleWindow"]);
      } catch (e) {
        this.currentSettings["shortcuts.toggleWindow"] = prevShortcut;
        throw e;
      }
    }

    await this.save();

    if (llmChanged) this.debounceRestart("llm");
    if (sttChanged) this.debounceRestart("stt");
    if (ttsEnabledChanged) {
      const nowEnabled = !!this.currentSettings["tts.enabled"];
      if (prevTtsEnabled !== nowEnabled) {
        const { ttsState } = await import("./tts.svelte");
        void ttsState.setEnabled(nowEnabled);
      }
    }
  }

  async save() {
    if (!browser) return;
    const defaults = getDefaultSettings();
    const current = $state.snapshot(this.currentSettings);
    const nonDefault: Record<string, any> = {};
    for (const [key, value] of Object.entries(current)) {
      if (value !== defaults[key]) {
        nonDefault[key] = value;
      }
    }
    // Partition out secret-typed fields so they never reach the JSON file.
    // Always include each secret key (empty value tells Rust to clear the
    // keychain entry).
    const secrets: Record<string, string> = {};
    for (const key of SECRET_KEYS) {
      const v = nonDefault[key];
      secrets[key] = typeof v === "string" ? v : "";
      delete nonDefault[key];
    }
    const snapshot = JSON.stringify(nonDefault, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      try {
        if (isTauri()) {
          await invoke("save_settings", { settings: JSON.parse(snapshot), secrets });
        } else {
          localStorage.setItem("tomat-settings", snapshot);
        }
      } catch (e) {
        console.warn("Failed to save settings:", e);
      }
    });
    await this.saveChain;
  }

  getAlignment(): Alignment {
    return this.currentSettings["layout.alignment"] || "center";
  }

  getMonitor(): string {
    return this.currentSettings["layout.monitor"]?.toString() || "primary";
  }
}

export const settingsState = new SettingsState();
