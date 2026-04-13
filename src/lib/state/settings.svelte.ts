import { browser } from "$app/environment";
import { getDefaultSettings, SECRET_KEYS } from "$lib/shared/settings";
import type { Alignment } from "$lib/shared/types";
import { invoke } from "@tauri-apps/api/core";

class SettingsState {
  currentSettings = $state<Record<string, any>>(getDefaultSettings());

  private restartTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private saveChain: Promise<void> = Promise.resolve();

  async loadSettings() {
    if (!browser) return;
    try {
      if ((window as any).__TAURI_INTERNALS__) {
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
    const prevEnabled = !!this.currentSettings["tts.enabled"];
    this.currentSettings[key] = value;
    await this.save();

    if (key.startsWith("llm.")) {
      this.debounceRestart("llm");
    } else if (key.startsWith("stt.")) {
      this.debounceRestart("stt");
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
    let llmChanged = false;
    let sttChanged = false;
    let ttsEnabledChanged = false;

    for (const [key, value] of Object.entries(updates)) {
      this.currentSettings[key] = value;
      if (key.startsWith("llm.")) llmChanged = true;
      if (key.startsWith("stt.")) sttChanged = true;
      if (key === "tts.enabled") ttsEnabledChanged = true;
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
        if ((window as any).__TAURI_INTERNALS__) {
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
