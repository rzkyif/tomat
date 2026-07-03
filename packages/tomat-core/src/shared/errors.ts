// Re-export shim: AppError and friends now live in @tomat/core-engine's platform
// layer (runtime-agnostic), so the engine and core throw + catch the SAME class
// (instanceof stays valid across the seam). Core keeps importing from this path
// unchanged; this file just forwards. Removed once every core importer points at
// the engine directly.

export {
  AppError,
  conflict,
  forbidden,
  internal,
  isAppError,
  isNoSpaceError,
  notFound,
  validation,
} from "@tomat/core-engine";
