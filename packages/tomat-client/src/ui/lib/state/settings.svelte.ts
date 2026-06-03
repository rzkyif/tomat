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
 * `onChange` to react to specific keys (settings-effects.ts).
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

// Debounce window for coalescing rapid edits into a single round-trip.
// 200ms is short enough that the user perceives saves as immediate but
// long enough that a flurry of keystrokes in one text field collapses
// into one PATCH instead of one PATCH per character.
const FLUSH_DEBOUNCE_MS = 200;

class SettingsState {
  // deno-lint-ignore no-explicit-any -- consumers treat values as untyped
  // and the schema-defaults loader builds a heterogeneous record.
  currentSettings = $state<Record<string, any>>(getDefaultSettings());

  // Names of secret-typed settings (API keys) the core reports as configured.
  // Core never returns secret VALUES, so the field stays empty in the UI; this
  // set lets password fields render a "saved" placeholder. Loaded from
  // GET /settings/secrets.
  configuredSecrets = $state<Set<string>>(new Set());

  // True once the paired core's settings have been merged into currentSettings
  // (loadCoreSettings). Until then the boot path holds only client-local +
  // default values, so save() must not PATCH core-destination keys. Doing so
  // would overwrite the core's real value with a stale default. See save().
  coreLoaded = $state(false);

  // Secret keys the user actually edited this session. Only these are written
  // on save. A loaded-but-untouched secret field is empty (we never receive
  // the value), so without this guard an unrelated save would delete the
  // configured vault entry.
  private dirtySecrets = new Set<string>();

  private listeners = new Set<SettingChangeListener>();

  /** True if the core reports a value stored for this secret-typed setting. */
  isSecretConfigured(key: string): boolean {
    return this.configuredSecrets.has(key);
  }

  // Coalesced flush state: `pendingPrev` records the *first* observed prev
  // value per key across a debounce window so a failed flush can roll the
  // UI back to where it started. Resolvers are notified per individual
  // updateSettings() call.
  private pendingPrev = new Map<string, unknown>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolvers: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];
  private flushInFlight: Promise<void> | null = null;

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

  /** Local-only load: defaults + the client settings file. Fast, no network.
   *  This is all the boot path needs before it can position, theme, and show
   *  the window. Resets the core-derived state so a stale core's values don't
   *  linger; loadCoreSettings() re-populates it. */
  async loadClientSettings(): Promise<void> {
    if (!browser) return;
    // deno-lint-ignore no-explicit-any
    let merged: Record<string, any> = { ...getDefaultSettings() };
    try {
      const clientStored = await platform().clientSettings.read();
      merged = { ...merged, ...clientStored };
    } catch (e) {
      console.warn("Failed to load client settings, using defaults:", e);
    }
    this.currentSettings = merged;
    // A fresh load discards any in-memory secret edits and core-derived state.
    this.dirtySecrets.clear();
    this.configuredSecrets = new Set();
    this.coreLoaded = false;

    // Push the persisted shortcut so Rust overrides the startup default. Local
    // Rust call; boot must not abort if the shortcut is taken. Log it and let
    // Settings fix.
    this.applyToggleWindowShortcut(this.currentSettings["shortcuts.toggleWindow"]).catch((e) =>
      console.warn("Failed to register persisted shortcut:", e),
    );
  }

  /** Merge the paired core's settings (and configured-secret names) over the
   *  already-loaded local settings. Networked: runs in the deferred boot phase
   *  after the window is visible. No-op when no core is paired. Lets failures
   *  propagate so the caller can surface them (console.error on the boot path).
   *  Appearance/layout keys are client-local, so this never changes the window. */
  async loadCoreSettings(): Promise<void> {
    if (!browser || !cores().currentEntry()) return;
    const coreStored = await cores().api().settings.load();
    this.currentSettings = { ...this.currentSettings, ...coreStored };
    // Learn which secret-typed settings have a value stored in the vault so
    // password fields can show a "saved" placeholder (the value is never
    // returned).
    const names = await cores().api().settings.listSecrets();
    this.configuredSecrets = new Set(names);
    this.coreLoaded = true;
  }

  /** Back-compat: local load then core merge. Prefer the split methods on the
   *  boot path so the window can show before the core round-trip. */
  async loadSettings(): Promise<void> {
    await this.loadClientSettings();
    try {
      await this.loadCoreSettings();
    } catch (e) {
      console.warn("Failed to load core settings, falling back:", e);
    }
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
      // Record explicit user edits to secret fields so save() writes only the
      // ones actually touched (an untouched secret field is empty because its
      // value is never returned, and must not clobber the vault entry).
      if (SECRET_KEY_SET.has(key)) this.dirtySecrets.add(key);
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

    // Record prev-values for rollback. Only set the FIRST observed prev per
    // key inside the debounce window so rapid edits coalesce correctly: if
    // the user toggles A→B→C in 50ms, a failed flush rolls back to A.
    for (const key of Object.keys(updates)) {
      if (!this.pendingPrev.has(key)) {
        this.pendingPrev.set(key, prevValues[key]);
      }
    }

    return await this.scheduleFlush();
  }

  /** Debounced flush scheduler. Each call resets the timer so rapid
   *  successive updates collapse into a single round-trip; the returned
   *  promise resolves (or rejects) when that flush completes. */
  private scheduleFlush(): Promise<void> {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    const p = new Promise<void>((resolve, reject) => {
      this.pendingResolvers.push({ resolve, reject });
    });
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    return p;
  }

  private async flush(): Promise<void> {
    // If a flush is already running, wait for it to finish before kicking
    // off the next one so we don't fire overlapping PATCHes to core.
    if (this.flushInFlight) {
      await this.flushInFlight.catch(() => {});
    }
    const prevSnapshot = new Map(this.pendingPrev);
    const resolvers = this.pendingResolvers.splice(0);
    this.pendingPrev.clear();

    const run = (async () => {
      try {
        await this.save();
        // Notify listeners only AFTER a successful persist so they can't
        // observe optimistically-set state that the core later rejects.
        for (const [key, prev] of prevSnapshot) {
          this.notifyListeners(key, prev, this.currentSettings[key]);
        }
        for (const r of resolvers) r.resolve();
      } catch (e) {
        // Roll back EVERY key in the batch. Partial rollback (e.g. only
        // shortcuts) leaves the UI lying about what core thinks.
        for (const [key, prev] of prevSnapshot) {
          this.currentSettings[key] = prev;
        }
        for (const r of resolvers) r.reject(e);
      }
    })();
    this.flushInFlight = run;
    try {
      await run;
    } finally {
      this.flushInFlight = null;
    }
  }

  /** Writes the current sparse-delta to every destination. Throws an
   *  AggregateError if any destination fails. Callers (flush()) treat
   *  any failure as a full-batch rollback signal. */
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
      // Secrets are handled separately below: only fields the user actually
      // edited this session are written, so an unrelated save can't wipe a
      // configured (but empty-in-UI) vault entry.
      if (SECRET_KEY_SET.has(key)) continue;
      if (Object.is(value, defaults[key])) continue;
      const dest = destinationFor(key);
      if (dest === "core") coreDelta[key] = value;
      else clientDelta[key] = value;
    }
    // Touched secrets only: a non-empty value sets the vault entry; an emptied
    // one clears it (the user explicitly deleted it).
    for (const key of this.dirtySecrets) {
      const value = current[key];
      secrets[key] = typeof value === "string" ? value : "";
    }

    // Try every destination; collect errors so the caller can roll back
    // optimistic UI state. Order: client → core PATCH → secrets, mirroring
    // the legacy save chain.
    const errors: unknown[] = [];
    try {
      // The client settings file is also where `cores().*` persists the paired
      // cores list + selected core id. `clientSettings.write` is a full
      // overwrite, so writing only this save's schema delta would wipe those
      // keys (booting the app back into the welcome flow). Read-modify-write:
      // strip the client-schema keys this save owns, keep everything else
      // (cores, currentCoreId, ...), then overlay the fresh sparse delta.
      const ownedKeys = new Set(Object.keys(defaults).filter((k) => destinationFor(k) !== "core"));
      const existing = await platform().clientSettings.read();
      const preserved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(existing)) {
        if (!ownedKeys.has(k)) preserved[k] = v;
      }
      await platform().clientSettings.write({ ...preserved, ...clientDelta });
    } catch (e) {
      console.warn("Failed to save client settings:", e);
      errors.push(e);
    }
    if (cores().currentEntry()) {
      const api = cores().api().settings;
      // Don't PATCH core keys until loadCoreSettings() has merged the core's
      // real values: before that a non-default key still holds a client/default
      // value, and patching it would overwrite the core's value. Client +
      // secrets saves below are unaffected. The window between show and merge is
      // sub-second, so this only bites a save made in that gap (or while the
      // core is unreachable, where the PATCH would fail anyway).
      if (Object.keys(coreDelta).length > 0 && !this.coreLoaded) {
        console.warn(
          "[settings] skipping core save before core settings loaded:",
          Object.keys(coreDelta),
        );
      } else {
        try {
          await api.patch(coreDelta);
        } catch (e) {
          console.warn("Failed to save core settings:", e);
          errors.push(e);
        }
      }
      const nextConfigured = new Set(this.configuredSecrets);
      const persisted: string[] = [];
      for (const [name, value] of Object.entries(secrets)) {
        try {
          if (value === "") {
            await api.deleteSecret(name);
            nextConfigured.delete(name);
          } else {
            await api.setSecret(name, value);
            nextConfigured.add(name);
          }
          persisted.push(name);
        } catch (e) {
          console.warn(`Failed to update secret "${name}":`, e);
          errors.push(e);
        }
      }
      // Reassign for Svelte reactivity, and forget the edits we committed.
      this.configuredSecrets = nextConfigured;
      for (const name of persisted) this.dirtySecrets.delete(name);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "settings save failed");
    }
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
