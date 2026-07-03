// Re-export shim: the sparse-settings readers now live in @tomat/core-engine
// (pure, runtime-agnostic). Core keeps importing from this path unchanged.

export { boolSetting, numSetting, strSetting } from "@tomat/core-engine/services/settings-access";
