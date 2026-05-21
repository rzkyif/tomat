/**
 * Reactive store for user settings. Routes reads/writes by group destination:
 *
 *   - "client" groups → ~/.tomat/client/settings.json via the platform's
 *     clientSettings.read/write (Tauri file write on desktop, localStorage
 *     in the browser stub).
 *   - "core" groups → currently-selected paired core via
 *     `cores().api().settings.{load,patch}`. Secret-typed fields go to
 *     the secrets vault via `setSecret`/`deleteSecret`.
 *
 * Loaded settings are merged onto the schema defaults; saves are sparse
 * (only non-default values are persisted). External code subscribes via
 * `onChange` to react to specific keys (settingsEffects.ts).
 */

import { browser, dev } from "$app/environment";
import {
  getDefaultSettings,
  isClientGroup,
  isCoreGroup,
  isValidSettingKey,
  SECRET_KEYS,
  SETTINGS_SCHEMA,
  type SettingGroupId,
} from "@tomat/shared";
import { platform } from "$lib/platform";
import { cores } from "$lib/core";
import type { Alignment } from "$lib/shared/types";

function warnIfUnknownKey(key: string): void {
  if (dev && !isValidSettingKey(key)) {
    console.warn(`[settings] writing unknown setting key: "${key}"`);
  }
}

type SettingChangeListener = (key: string, prev: unknown, next: unknown) => void | Promise<void>;

// Per-key destination lookup: settings.ts loads the schema once and
// pre-computes which destination each known key belongs to so the per-key
// save path doesn't have to walk the schema every time.
const KEY_DESTINATION = (() => {
  const map = new Map<string, "client" | "core">();
  for (const group of SETTINGS_SCHEMA) {
    for (const section of group.sections) {
      for (const field of section.fields) {
        map.set(field.id, group.destination);
      }
    }
  }
  return map;
})();

const SECRET_KEY_SET = new Set<string>(SECRET_KEYS);

function destinationFor(key: string): "client" | "core" {
  return KEY_DESTINATION.get(key) ?? "client";
}

class SettingsState {
  // deno-lint-ignore no-explicit-any -- consumers treat values as untyped
  // and the schema-defaults loader builds a heterogeneous record.
  currentSettings = $state<Record<string, any>>(getDefaultSettings());

  private saveChain: Promise<void> = Promise.resolve();
  private listeners = new Set<SettingChangeListener>();

  onChange(fn: SettingChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notifyListeners(key: string, prev: unknown, next: unknown): void {
    for (const fn of this.listeners) {
      try {
        void Promise.resolve(fn(key, prev, next)).catch((e) =>
          console.warn(`[settings] onChange listener for "${key}" failed:`, e),
        );
      } catch (e) {
        console.warn(`[settings] onChange listener for "${key}" failed:`, e);
      }
    }
  }

  async loadSettings(): Promise<void> {
    if (!browser) return;
    const defaults = getDefaultSettings();
    // deno-lint-ignore no-explicit-any
    let merged: Record<string, any> = { ...defaults };
    try {
      const clientStored = await platform().clientSettings.read();
      merged = { ...merged, ...clientStored };
    } catch (e) {
      console.warn("Failed to load client settings, using defaults:", e);
    }
    try {
      if (cores().currentEntry()) {
        const coreStored = await cores().api().settings.load();
        merged = { ...merged, ...coreStored };
      }
    } catch (e) {
      console.warn("Failed to load core settings, falling back:", e);
    }
    this.currentSettings = merged;

    // Push the persisted shortcut so Rust overrides the startup default.
    // Boot must not abort if the shortcut is taken; log and let Settings fix.
    this.applyToggleWindowShortcut(this.currentSettings["shortcuts.toggleWindow"]).catch((e) =>
      console.warn("Failed to register persisted shortcut:", e),
    );
  }

  private async applyToggleWindowShortcut(value: unknown): Promise<void> {
    const accelerator = typeof value === "string" && value.length > 0 ? value : null;
    await platform().shortcuts.setBinding(accelerator);
  }

  async updateSetting(key: string, value: unknown): Promise<void> {
    return await this.updateSettings({ [key]: value });
  }

  async updateSettings(updates: Record<string, unknown>): Promise<void> {
    const prevValues: Record<string, unknown> = {};
    const prevShortcut = this.currentSettings["shortcuts.toggleWindow"];
    let toggleShortcutChanged = false;
    let nonToggleShortcutToValidate: { key: string; value: string } | undefined;

    for (const [key, value] of Object.entries(updates)) {
      warnIfUnknownKey(key);
      prevValues[key] = this.currentSettings[key];
      this.currentSettings[key] = value;
      if (key === "shortcuts.toggleWindow") toggleShortcutChanged = true;
      if (
        (key === "shortcuts.attachFile" ||
          key === "shortcuts.captureScreen" ||
          key === "shortcuts.captureRegion") &&
        typeof value === "string" &&
        value.trim().length > 0
      ) {
        nonToggleShortcutToValidate = { key, value };
      }
    }

    if (toggleShortcutChanged) {
      try {
        await this.applyToggleWindowShortcut(this.currentSettings["shortcuts.toggleWindow"]);
      } catch (e) {
        this.currentSettings["shortcuts.toggleWindow"] = prevShortcut;
        throw e;
      }
    }
    if (nonToggleShortcutToValidate) {
      // Probe-validate the combo before persisting. Re-registration happens
      // when UserInput remounts; this just surfaces "already taken" so the
      // bad value doesn't get saved.
      try {
        await platform().shortcuts.validate(nonToggleShortcutToValidate.value);
      } catch (e) {
        const k = nonToggleShortcutToValidate.key;
        this.currentSettings[k] = prevValues[k];
        throw e;
      }
    }

    await this.save();

    for (const [key, value] of Object.entries(updates)) {
      this.notifyListeners(key, prevValues[key], value);
    }
  }

  async save(): Promise<void> {
    if (!browser) return;
    const defaults = getDefaultSettings();
    // deno-lint-ignore no-explicit-any
    const current = $state.snapshot(this.currentSettings) as Record<string, any>;
    // Split sparse non-default values by destination + secret-vault.
    const clientDelta: Record<string, unknown> = {};
    const coreDelta: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(current)) {
      const isSecret = SECRET_KEY_SET.has(key);
      if (isSecret) {
        // Always include — empty string means "clear the vault entry".
        secrets[key] = typeof value === "string" ? value : "";
        continue;
      }
      if (Object.is(value, defaults[key])) continue;
      const dest = destinationFor(key);
      if (dest === "core") coreDelta[key] = value;
      else clientDelta[key] = value;
    }

    this.saveChain = this.saveChain.then(async () => {
      try {
        await platform().clientSettings.write(clientDelta);
      } catch (e) {
        console.warn("Failed to save client settings:", e);
      }
      if (cores().currentEntry()) {
        const api = cores().api().settings;
        try {
          await api.patch(coreDelta);
        } catch (e) {
          console.warn("Failed to save core settings:", e);
        }
        // Push every secret (empty = delete) so the vault matches what
        // the user typed in the password fields.
        for (const [name, value] of Object.entries(secrets)) {
          try {
            if (value === "") await api.deleteSecret(name);
            else await api.setSecret(name, value);
          } catch (e) {
            console.warn(`Failed to update secret "${name}":`, e);
          }
        }
      }
    });
    await this.saveChain;
  }

  getAlignment(): Alignment {
    return (this.currentSettings["layout.alignment"] as Alignment) ?? "center";
  }

  getMonitor(): string {
    return this.currentSettings["layout.monitor"]?.toString() || "primary";
  }
}

// Re-exported for downstream consumers that want to introspect destinations.
export { isClientGroup, isCoreGroup, type SettingGroupId };

export const settingsState = new SettingsState();
