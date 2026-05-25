// OS-keychain wrapper for paired-core bearer tokens.
//
// Service: "tomat-client". Account format: "core:<coreId>", where <coreId> is
// the ULID assigned by the core during pairing-claim. We always go to the OS
// keychain; there is no dev fallback, because clients are signed and the
// keychain is reliable across the rebuild cycles that affect tomat-core's
// secrets store.
//
// The `KeychainStore` trait is the test seam: production goes through
// `RealKeychain` (the `keyring` crate); unit tests use `InMemoryKeychain`.

use crate::error::{AppError, AppResult};
use keyring::Entry;

const SERVICE: &str = "tomat-client";

// Input limits applied at the Tauri command boundary. Real values are far
// smaller (ULID core_id = 26 chars; bearer token = 43 chars base64url),
// but capping defends against a misbehaving caller pinning memory or
// exhausting the OS keychain via a giant write.
const MAX_CORE_ID_LEN: usize = 64;
const MAX_TOKEN_LEN: usize = 256;

pub trait KeychainStore: Send + Sync {
    fn set(&self, account: &str, token: &str) -> AppResult<()>;
    fn get(&self, account: &str) -> AppResult<Option<String>>;
    fn delete(&self, account: &str) -> AppResult<()>;
}

pub struct RealKeychain;

impl KeychainStore for RealKeychain {
    fn set(&self, account: &str, token: &str) -> AppResult<()> {
        let entry = Entry::new(SERVICE, account)?;
        entry.set_password(token).map_err(classify_keyring_error)?;
        Ok(())
    }
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        let entry = Entry::new(SERVICE, account)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(classify_keyring_error(err)),
        }
    }
    fn delete(&self, account: &str) -> AppResult<()> {
        let entry = Entry::new(SERVICE, account)?;
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(classify_keyring_error(err)),
        }
    }
}

/// Map a raw `keyring::Error` into one of three generic codes so the UI
/// (and any log line that captures the error) never sees platform-specific
/// detail like exact file paths, COM HRESULTs, or DBus method names — those
/// can be useful for debugging but leak host topology to anyone who can
/// read the client logs.
fn classify_keyring_error(err: keyring::Error) -> AppError {
    use keyring::Error as E;
    let code = match err {
        E::NoEntry => "keychain:not_found",
        // PlatformFailure / NoStorageAccess on macOS map to the user
        // refusing the keychain prompt or the daemon being unreachable.
        E::PlatformFailure(_) | E::NoStorageAccess(_) => "keychain:unavailable",
        // BadEncoding / TooLong / Invalid are caller-input mistakes we
        // already cap before calling; surface as denied so the user knows
        // it's not their cert/keyring config.
        E::BadEncoding(_) | E::TooLong(_, _) | E::Invalid(_, _) => "keychain:denied",
        _ => "keychain:unavailable",
    };
    AppError::External(code.to_string())
}

#[tauri::command]
pub fn keychain_set_token(core_id: String, token: String) -> AppResult<()> {
    validate_core_id(&core_id)?;
    validate_token(&token)?;
    set_token(&RealKeychain, &core_id, &token)
}

#[tauri::command]
pub fn keychain_get_token(core_id: String) -> AppResult<Option<String>> {
    validate_core_id(&core_id)?;
    get_token(&RealKeychain, &core_id)
}

#[tauri::command]
pub fn keychain_delete_token(core_id: String) -> AppResult<()> {
    validate_core_id(&core_id)?;
    delete_token(&RealKeychain, &core_id)
}

fn validate_core_id(id: &str) -> AppResult<()> {
    if id.is_empty() {
        return Err(AppError::validation("core_id is empty"));
    }
    if id.len() > MAX_CORE_ID_LEN {
        return Err(AppError::validation(format!(
            "core_id exceeds {} chars",
            MAX_CORE_ID_LEN
        )));
    }
    // Restrict to URL-safe ULID-shaped chars so account strings can never
    // contain keychain delimiters that the platform might interpret oddly.
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::validation("core_id has disallowed characters"));
    }
    Ok(())
}

fn validate_token(token: &str) -> AppResult<()> {
    if token.is_empty() {
        return Err(AppError::validation("token is empty"));
    }
    if token.len() > MAX_TOKEN_LEN {
        return Err(AppError::validation(format!(
            "token exceeds {} chars",
            MAX_TOKEN_LEN
        )));
    }
    Ok(())
}

pub fn set_token<S: KeychainStore + ?Sized>(
    store: &S,
    core_id: &str,
    token: &str,
) -> AppResult<()> {
    store.set(&account(core_id), token)
}

pub fn get_token<S: KeychainStore + ?Sized>(store: &S, core_id: &str) -> AppResult<Option<String>> {
    store.get(&account(core_id))
}

pub fn delete_token<S: KeychainStore + ?Sized>(store: &S, core_id: &str) -> AppResult<()> {
    store.delete(&account(core_id))
}

fn account(core_id: &str) -> String {
    format!("core:{}", core_id)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct InMemoryKeychain {
        inner: Mutex<HashMap<String, String>>,
    }

    impl KeychainStore for InMemoryKeychain {
        fn set(&self, account: &str, token: &str) -> AppResult<()> {
            self.inner
                .lock()
                .unwrap()
                .insert(account.to_string(), token.to_string());
            Ok(())
        }
        fn get(&self, account: &str) -> AppResult<Option<String>> {
            Ok(self.inner.lock().unwrap().get(account).cloned())
        }
        fn delete(&self, account: &str) -> AppResult<()> {
            self.inner.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn account_uses_core_prefix() {
        assert_eq!(account("01H8XGJWBWBAQ4WG"), "core:01H8XGJWBWBAQ4WG");
    }

    #[test]
    fn set_then_get_round_trips() {
        let store = InMemoryKeychain::default();
        set_token(&store, "abc", "bearer-xyz").unwrap();
        assert_eq!(get_token(&store, "abc").unwrap(), Some("bearer-xyz".into()));
    }

    #[test]
    fn get_returns_none_for_missing_entry() {
        let store = InMemoryKeychain::default();
        assert_eq!(get_token(&store, "missing").unwrap(), None);
    }

    #[test]
    fn delete_removes_entry_and_is_idempotent() {
        let store = InMemoryKeychain::default();
        set_token(&store, "abc", "t").unwrap();
        delete_token(&store, "abc").unwrap();
        delete_token(&store, "abc").unwrap();
        assert_eq!(get_token(&store, "abc").unwrap(), None);
    }

    #[test]
    fn validate_core_id_rejects_empty_oversized_and_disallowed_chars() {
        assert!(validate_core_id("").is_err());
        assert!(validate_core_id(&"a".repeat(MAX_CORE_ID_LEN + 1)).is_err());
        assert!(validate_core_id("with space").is_err());
        assert!(validate_core_id("with/slash").is_err());
        assert!(validate_core_id("01H8XGJWBWBAQ4WG-ok_too").is_ok());
    }

    #[test]
    fn validate_token_rejects_empty_and_oversized() {
        assert!(validate_token("").is_err());
        assert!(validate_token(&"x".repeat(MAX_TOKEN_LEN + 1)).is_err());
        // Tokens may contain '=' and other base64url padding; we only
        // gate on length, not character class.
        assert!(validate_token("abc==").is_ok());
    }

    #[test]
    fn classify_keyring_error_maps_to_generic_codes() {
        // NoEntry → not_found
        let e = classify_keyring_error(keyring::Error::NoEntry);
        assert_eq!(format!("{}", e), "keychain:not_found");
        // BadEncoding → denied (caller-input mistake)
        let e = classify_keyring_error(keyring::Error::BadEncoding(vec![0xff]));
        assert_eq!(format!("{}", e), "keychain:denied");
        // TooLong → denied
        let e = classify_keyring_error(keyring::Error::TooLong("svc".into(), 10));
        assert_eq!(format!("{}", e), "keychain:denied");
    }
}
