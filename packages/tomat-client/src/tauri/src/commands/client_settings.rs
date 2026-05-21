// Client-side settings JSON file at ~/.tomat/client/settings.json.
// Sparse: only non-defaults are persisted. The frontend's settings schema
// owns the field IDs and default values; this layer just reads/writes the
// raw JSON.

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::PathBuf;

#[tauri::command]
pub fn read_client_settings() -> AppResult<Value> {
    let path = client_settings_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(AppError::from),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Object(Default::default()))
        }
        Err(err) => Err(AppError::Io(err)),
    }
}

#[tauri::command]
pub fn write_client_settings(settings: Value) -> AppResult<()> {
    if !settings.is_object() {
        return Err(AppError::validation("settings must be an object"));
    }
    let path = client_settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn client_settings_path() -> AppResult<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| AppError::external("could not determine home directory"))?;
    Ok(home.join(".tomat").join("client").join("settings.json"))
}
