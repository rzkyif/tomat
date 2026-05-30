// Client-side settings JSON file at ~/.tomat/<channel>/client/settings.json.
// Sparse: only non-defaults are persisted. The frontend's settings schema
// owns the field IDs and default values; this layer just reads/writes the
// raw JSON.
//
// The Tauri commands delegate to plain functions that take an explicit
// path so unit tests can drive them against a tempdir instead of the
// real home directory.

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[tauri::command]
pub fn read_client_settings() -> AppResult<Value> {
    read_settings_at(&client_settings_path()?)
}

#[tauri::command]
pub fn write_client_settings(settings: Value) -> AppResult<()> {
    write_settings_at(&client_settings_path()?, settings)
}

pub fn read_settings_at(path: &Path) -> AppResult<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(AppError::from),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Object(Default::default()))
        }
        Err(err) => Err(AppError::Io(err)),
    }
}

pub fn write_settings_at(path: &Path, settings: Value) -> AppResult<()> {
    if !settings.is_object() {
        return Err(AppError::validation("settings must be an object"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn client_settings_path() -> AppResult<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| AppError::external("could not determine home directory"))?;
    Ok(crate::channel::channel_root(&home)
        .join("client")
        .join("settings.json"))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::env;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn unique_path(name: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        env::temp_dir()
            .join(format!(
                "tomat-client-settings-{}-{}",
                std::process::id(),
                n
            ))
            .join(name)
    }

    #[test]
    fn read_missing_file_returns_empty_object() {
        let path = unique_path("settings.json");
        let val = read_settings_at(&path).unwrap();
        assert_eq!(val, json!({}));
    }

    #[test]
    fn write_then_read_round_trips_object() {
        let path = unique_path("settings.json");
        write_settings_at(&path, json!({ "theme": "dark", "fontSize": 14 })).unwrap();
        let val = read_settings_at(&path).unwrap();
        assert_eq!(val["theme"], "dark");
        assert_eq!(val["fontSize"], 14);
    }

    #[test]
    fn write_rejects_non_object_values() {
        let path = unique_path("settings.json");
        let err = write_settings_at(&path, json!([1, 2, 3])).unwrap_err();
        // The error envelope is the AppError variant we threw, not an io
        // error from filesystem ops.
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn write_creates_parent_directories() {
        let path = unique_path("nested/deeper/settings.json");
        write_settings_at(&path, json!({ "k": "v" })).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn read_propagates_invalid_json_as_app_error() {
        let path = unique_path("settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ not json").unwrap();
        let err = read_settings_at(&path).unwrap_err();
        // serde_json::Error round-trips through AppError::Serde via #[from].
        assert!(matches!(err, AppError::Serde(_)));
    }
}
