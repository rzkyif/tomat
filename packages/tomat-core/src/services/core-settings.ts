// Re-export shim: the sparse core-settings store (global + per-client overlays)
// now lives in @tomat/core-engine (it reaches settings.json through host().fs and
// the client_settings table through the shared db()). Core keeps importing from
// this path unchanged; this file forwards.

export {
  __resetForTesting,
  dropClientSettingsCache,
  loadCoreSettings,
  loadCoreSettingsResolved,
  loadEffective,
  patchClientSettings,
  patchCoreSettings,
  resetAllClientSettings,
  resetCoreSettings,
  subscribeClientSettings,
  subscribeCoreSettings,
} from "@tomat/core-engine/services/core-settings";
export type {
  ClientSettingsListener,
  SettingsListener,
} from "@tomat/core-engine/services/core-settings";
