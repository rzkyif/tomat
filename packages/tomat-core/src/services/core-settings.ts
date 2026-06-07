// Sparse settings file at ~/.tomat/core/settings.json. Only non-default
// values are serialized; defaults come from the schema in @tomat/shared.
//
// This module is intentionally untyped at the value layer. The schema in
// @tomat/shared/domain/settings.ts owns field IDs and defaults, and the
// route layer typechecks PATCH bodies against it. Here we just persist a
// JSON record atomically.

import { paths } from "../paths.ts";
import { errMessage, getDefaultSettings } from "@tomat/shared";
import { AppError } from "../shared/errors.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("core-settings");

let cached: Record<string, unknown> | null = null;

// Test-only: drops the in-memory cache so the next `loadCoreSettings()`
// re-reads from disk. Also clears subscribers; test setup wires its own.
export function __resetForTesting(): void {
  cached = null;
  listeners.clear();
}

export type SettingsListener = (
  settings: Record<string, unknown>,
  changedKeys: ReadonlySet<string>,
) => void | Promise<void>;

const listeners = new Set<SettingsListener>();

export async function loadCoreSettings(): Promise<Record<string, unknown>> {
  if (cached) return cached;
  try {
    const text = await Deno.readTextFile(paths().settingsFile);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new AppError("internal_error", "settings file is not an object");
    }
    cached = parsed as Record<string, unknown>;
    return cached;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      cached = {};
      return cached;
    }
    throw err;
  }
}

/** Settings with schema defaults applied; persisted (sparse) values win. The
 *  on-disk file stores only non-default values, so any consumer that needs the
 *  effective configuration - not just the keys the user explicitly changed -
 *  must read through this. Requirement computation relies on it (e.g. the
 *  default model path / `llm.supportImages` aren't persisted when unchanged). */
export async function loadCoreSettingsResolved(): Promise<Record<string, unknown>> {
  return { ...getDefaultSettings(), ...(await loadCoreSettings()) };
}

export async function patchCoreSettings(
  partial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const current = await loadCoreSettings();
  const merged: Record<string, unknown> = { ...current };
  const changed = new Set<string>();
  for (const [k, v] of Object.entries(partial)) {
    if (v === null || v === undefined) {
      if (k in merged) {
        delete merged[k];
        changed.add(k);
      }
    } else if (!Object.is(merged[k], v)) {
      merged[k] = v;
      changed.add(k);
    }
  }
  await writeAtomic(merged);
  cached = merged;
  if (changed.size > 0) {
    for (const l of listeners) {
      try {
        await l(merged, changed);
      } catch (err) {
        // Listeners are fire-and-forget; surface log but don't block PATCH.
        log.error(`settings listener error: ${errMessage(err)}`);
      }
    }
  }
  return merged;
}

/** Reset all settings to their schema defaults: the sparse on-disk file becomes
 *  empty (`{}` means "every value is the default") and listeners fire with every
 *  previously-set key marked changed. Used by the Storage view's "clear
 *  settings" (factory reset). Secrets are wiped separately by the caller. */
export async function resetCoreSettings(): Promise<void> {
  const previous = await loadCoreSettings();
  const changed = new Set(Object.keys(previous));
  await writeAtomic({});
  cached = {};
  if (changed.size > 0) {
    for (const l of listeners) {
      try {
        await l(cached, changed);
      } catch (err) {
        log.error(`settings listener error: ${errMessage(err)}`);
      }
    }
  }
}

/** Subscribe to settings changes. Listener fires AFTER the atomic write
 *  with the full merged settings + a set of just-changed keys. */
export function subscribeCoreSettings(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function writeAtomic(value: Record<string, unknown>): Promise<void> {
  const tmp = paths().settingsFile + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(value, null, 2));
  await Deno.rename(tmp, paths().settingsFile);
}
