// Re-export shim: external-provider API-key resolution now lives in
// @tomat/core-engine (it reaches the vault through host().secureStore). Core
// keeps importing from this path unchanged.

export {
  EXTERNAL_TIMEOUT_MS,
  isLocalhostUrl,
  resolveExternalApiKey,
} from "@tomat/core-engine/services/external-endpoint";
