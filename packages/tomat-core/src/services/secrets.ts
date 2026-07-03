// Re-export shim: the secrets vault now lives in @tomat/core-engine
// (runtime-agnostic; the master key + secrets.enc are reached through
// host().secureStore / host().fs). Core keeps importing from this path
// unchanged; this file forwards. Removed once every core importer points at the
// engine directly.

export {
  __resetForTesting,
  clearAllSecrets,
  deleteSecret,
  getSecret,
  listSecretNames,
  setSecret,
  subscribeSecretsChanged,
  warnIfVaultUnreadable,
} from "@tomat/core-engine/services/secrets";
