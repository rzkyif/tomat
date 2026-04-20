//! User settings + secrets.
//!
//! Non-secret settings live in `~/.tomat/settings.json`. Secrets are split
//! by build profile: dev stores them in a plaintext fallback file next to
//! the executable (because unsigned dev builds can't reliably persist
//! keychain entries across rebuilds); release stores them in the OS
//! keychain exclusively.

use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "tomat";

fn keychain_set(key: &str, value: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)?;
    entry.set_password(value)?;
    Ok(())
}

fn keychain_get(key: &str) -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn keychain_delete(key: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key)?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// Dev-only hidden fallback file for secrets. In unsigned Tauri dev builds
// the OS keychain is unreliable across rebuilds (every rebuild changes the
// code signature and loses access to entries it wrote on a previous run,
// silently returning None on subsequent reads). For RELEASE builds this
// code path is never taken - production secrets must only ever live in the
// OS keychain. Gated on `debug_assertions` so it's physically impossible
// for a release binary to read or write this file.
#[cfg(debug_assertions)]
pub(crate) const SECRETS_FALLBACK_ENABLED: bool = true;
#[cfg(not(debug_assertions))]
pub(crate) const SECRETS_FALLBACK_ENABLED: bool = false;

pub(crate) fn secrets_fallback_path(_handle: &AppHandle) -> AppResult<PathBuf> {
    // Co-locate with the running executable rather than putting it under
    // `~/.tomat/` where a well-known path makes it a softer target. In dev
    // this ends up under `src-tauri/target/debug/` (gitignored, also makes
    // `cargo clean` / binary removal auto-wipe it).
    let exe = std::env::current_exe()?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| AppError::external("Could not determine executable directory"))?;
    Ok(exe_dir.join(".secrets.json"))
}

async fn read_fallback_secrets(path: &Path) -> HashMap<String, String> {
    if !SECRETS_FALLBACK_ENABLED {
        return HashMap::new();
    }
    let Ok(content) = tokio::fs::read_to_string(path).await else {
        return HashMap::new();
    };
    serde_json::from_str::<HashMap<String, String>>(&content).unwrap_or_default()
}

async fn write_fallback_secrets(path: &Path, map: &HashMap<String, String>) -> AppResult<()> {
    if !SECRETS_FALLBACK_ENABLED {
        // Never keep stale entries around in release builds, either.
        if path.exists() {
            tokio::fs::remove_file(path).await?;
        }
        return Ok(());
    }
    if map.is_empty() {
        if path.exists() {
            tokio::fs::remove_file(path).await?;
        }
        return Ok(());
    }
    let content = serde_json::to_string_pretty(map)?;
    tokio::fs::write(path, content).await?;
    Ok(())
}

/// Persist user settings. `settings` is written verbatim to
/// `~/.tomat/settings.json`. Secrets are handled strictly by build profile:
/// - **Dev** (`debug_assertions`): written to `~/.tomat/.secrets.json` only.
///   The keychain is bypassed entirely because unsigned dev builds can't
///   reliably persist keychain entries across rebuilds (set usually appears
///   to succeed but reads return nothing on the next launch).
/// - **Release**: written to the OS keychain only. `.secrets.json` is never
///   touched, so API keys never land on disk unencrypted.
#[tauri::command]
pub async fn save_settings(
    handle: AppHandle,
    settings: serde_json::Value,
    secrets: HashMap<String, String>,
) -> AppResult<()> {
    let home = handle.path().home_dir()?;
    let settings_dir = home.join(".tomat");
    tokio::fs::create_dir_all(&settings_dir).await?;

    if !matches!(settings, serde_json::Value::Object(_)) {
        return Err(AppError::validation("settings must be a JSON object"));
    }

    if SECRETS_FALLBACK_ENABLED {
        let fallback_path = secrets_fallback_path(&handle)?;
        let mut fallback = read_fallback_secrets(&fallback_path).await;
        for (key, value) in &secrets {
            if value.is_empty() {
                fallback.remove(key);
            } else {
                fallback.insert(key.clone(), value.clone());
            }
        }
        write_fallback_secrets(&fallback_path, &fallback).await?;
    } else {
        for (key, value) in &secrets {
            if value.is_empty() {
                if let Err(e) = keychain_delete(key) {
                    eprintln!("[settings] keychain delete failed for {key}: {e}");
                }
            } else if let Err(e) = keychain_set(key, value) {
                eprintln!("[settings] keychain set failed for {key}: {e}");
            }
        }
    }

    let settings_path = settings_dir.join("settings.json");
    let content = serde_json::to_string_pretty(&settings)?;
    tokio::fs::write(settings_path, content).await?;
    Ok(())
}

/// Load user settings. Secrets are resolved per build profile - dev reads
/// from `~/.tomat/.secrets.json`, release reads from the OS keychain.
#[tauri::command]
pub async fn load_settings(
    handle: AppHandle,
    secret_keys: Vec<String>,
) -> AppResult<serde_json::Value> {
    let home = handle.path().home_dir()?;
    let settings_path = home.join(".tomat").join("settings.json");

    let mut obj = if settings_path.exists() {
        let content = tokio::fs::read_to_string(&settings_path).await?;
        match serde_json::from_str::<serde_json::Value>(&content)? {
            serde_json::Value::Object(map) => map,
            _ => serde_json::Map::new(),
        }
    } else {
        serde_json::Map::new()
    };

    if SECRETS_FALLBACK_ENABLED {
        let fallback_path = secrets_fallback_path(&handle)?;
        let fallback = read_fallback_secrets(&fallback_path).await;
        for key in &secret_keys {
            if let Some(v) = fallback.get(key) {
                obj.insert(key.clone(), serde_json::Value::String(v.clone()));
            }
        }
    } else {
        for key in &secret_keys {
            match keychain_get(key) {
                Ok(Some(v)) => {
                    obj.insert(key.clone(), serde_json::Value::String(v));
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("[settings] keychain get failed for {key}: {e}");
                }
            }
        }
    }

    if obj.is_empty() && !settings_path.exists() {
        return Ok(serde_json::json!(null));
    }
    Ok(serde_json::Value::Object(obj))
}

pub(crate) async fn clear_secrets(handle: &AppHandle, secret_keys: &[String]) -> AppResult<()> {
    if SECRETS_FALLBACK_ENABLED {
        let fallback_path = secrets_fallback_path(handle)?;
        if fallback_path.exists() {
            tokio::fs::remove_file(&fallback_path).await?;
        }
    } else {
        for key in secret_keys {
            if let Err(e) = keychain_delete(key) {
                eprintln!("[settings] keychain delete failed for {key}: {e}");
            }
        }
    }
    Ok(())
}
