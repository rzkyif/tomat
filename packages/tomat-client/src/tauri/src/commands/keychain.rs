// OS-keychain wrapper for paired-core bearer tokens.
//
// Service: "tomat-client". Account format: "core:<coreId>", where <coreId> is
// the ULID assigned by the core during pairing-claim. We always go to the OS
// keychain; there is no dev fallback, because clients are signed and the
// keychain is reliable across the rebuild cycles that affect tomat-core's
// secrets store.

use crate::error::{AppError, AppResult};
use keyring::Entry;

const SERVICE: &str = "tomat-client";

#[tauri::command]
pub fn keychain_set_token(core_id: String, token: String) -> AppResult<()> {
    let entry = Entry::new(SERVICE, &account(&core_id))?;
    entry.set_password(&token)?;
    Ok(())
}

#[tauri::command]
pub fn keychain_get_token(core_id: String) -> AppResult<Option<String>> {
    let entry = Entry::new(SERVICE, &account(&core_id))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(AppError::Keyring(err)),
    }
}

#[tauri::command]
pub fn keychain_delete_token(core_id: String) -> AppResult<()> {
    let entry = Entry::new(SERVICE, &account(&core_id))?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(AppError::Keyring(err)),
    }
}

fn account(core_id: &str) -> String {
    format!("core:{}", core_id)
}
