import { browser } from "$app/environment";
import { getDefaultSettings } from "$lib/shared/settings";
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
        const stored = (await invoke("load_settings")) as Record<string, any> | null;
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

  async updateSetting(key: string, value: any) {
    this.currentSettings[key] = value;
    await this.save();

    if (key.startsWith("llm.")) {
      this.debounceRestart("llm");
    } else if (key.startsWith("stt.")) {
      this.debounceRestart("stt");
    }
  }

  async updateSettings(updates: Record<string, any>) {
    let llmChanged = false;
    let sttChanged = false;

    for (const [key, value] of Object.entries(updates)) {
      this.currentSettings[key] = value;
      if (key.startsWith("llm.")) llmChanged = true;
      if (key.startsWith("stt.")) sttChanged = true;
    }
    await this.save();

    if (llmChanged) this.debounceRestart("llm");
    if (sttChanged) this.debounceRestart("stt");
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
    const snapshot = JSON.stringify(nonDefault, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      try {
        if ((window as any).__TAURI_INTERNALS__) {
          await invoke("save_settings", { settings: JSON.parse(snapshot) });
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
