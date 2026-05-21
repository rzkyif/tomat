//! Tauri commands, organized by domain.
//!
//! Only platform-specific commands remain: everything server-side
//! (sessions, settings, sidecars, downloads, toolkits, storage) moved to
//! tomat-core and is reached over HTTP/WS by the frontend.
//!
//! Submodules:
//! - [`window`]: main-window visibility, positioning, global / input shortcuts.
//! - [`capture`]: monitor enumeration, full-monitor capture, region-capture overlay.
//! - [`fonts`]: installed system font enumeration.
//! - [`pairing`]: read on-disk admin token, install local core (CDN-dependent).
//! - [`client_settings`]: read/write ~/.tomat/client/settings.json.
//! - [`keychain`]: per-core bearer token storage via the OS keychain.

pub mod capture;
pub mod client_settings;
pub mod fonts;
pub mod keychain;
pub mod pairing;
pub mod window;

pub use capture::{
    capture_monitor, capture_monitor_region, get_region_capture_target,
    hide_region_capture_overlay, list_capture_monitors, set_region_capture_target,
    show_region_capture_overlay,
};
pub use client_settings::{read_client_settings, write_client_settings};
pub use fonts::list_system_fonts;
pub use keychain::{keychain_delete_token, keychain_get_token, keychain_set_token};
pub use pairing::{install_local_core, read_admin_token};
pub use window::{
    hide_main_window, position_window, request_hide_main_window, set_global_shortcut,
    set_input_shortcuts, show_main_window, toggle_main_window, validate_shortcut,
};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use tauri::{AppHandle, Manager, State};

// -------------------------------------------------------------------
// System volume
// -------------------------------------------------------------------

/// Read the default output device's master volume as a 0–100 percent value.
#[tauri::command]
pub async fn get_system_volume() -> AppResult<u8> {
    Ok(cpvc::get_system_volume())
}

/// Lower the system volume to `percent` of its current value for the duration
/// of an STT listening session, capturing the original level into
/// `state.saved_volume` so it can be restored later.
#[tauri::command]
pub async fn set_system_volume(state: State<'_, AppState>, percent: u8) -> AppResult<()> {
    let percent = percent.min(100);
    let baseline: u8 = {
        let mut saved = state
            .0
            .saved_volume
            .lock()
            .map_err(|e| AppError::external(format!("saved_volume mutex poisoned: {e}")))?;
        match *saved {
            Some(v) => v,
            None => {
                let current = cpvc::get_system_volume();
                *saved = Some(current);
                current
            }
        }
    };
    let target = (((baseline as u32) * (percent as u32) + 50) / 100).min(100) as u8;
    if !cpvc::set_system_volume(target) {
        return Err(AppError::external(
            "Failed to set system volume via cpvc".to_string(),
        ));
    }
    Ok(())
}

/// Restore the previously-captured system volume (set by `set_system_volume`).
#[tauri::command]
pub async fn restore_system_volume(state: State<'_, AppState>) -> AppResult<()> {
    let prev = {
        let mut saved = state
            .0
            .saved_volume
            .lock()
            .map_err(|e| AppError::external(format!("saved_volume mutex poisoned: {e}")))?;
        saved.take()
    };
    if let Some(v) = prev {
        if !cpvc::set_system_volume(v) {
            return Err(AppError::external(
                "Failed to restore system volume via cpvc".to_string(),
            ));
        }
    }
    Ok(())
}

// -------------------------------------------------------------------
// Path resolution
// -------------------------------------------------------------------

/// Expand a leading `~` in the given path to the user's home directory.
#[tauri::command]
pub fn resolve_path(handle: AppHandle, path: String) -> AppResult<String> {
    if let Some(rest) = path.strip_prefix('~') {
        let home = handle.path().home_dir()?;
        let rest = rest.trim_start_matches('/');
        Ok(home.join(rest).to_string_lossy().to_string())
    } else {
        Ok(std::path::Path::new(&path).to_string_lossy().to_string())
    }
}

// -------------------------------------------------------------------
// File conversion (anytomd + pdf-extract)
// -------------------------------------------------------------------

const MAX_CONVERTIBLE_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Convert the file at `file_path` to Markdown for attachment as document
/// context. Kept client-side so the rich Rust crate ecosystem stays
/// available; the client POSTs the resulting markdown to core.
#[tauri::command]
pub async fn convert_file_to_markdown(file_path: String) -> AppResult<String> {
    let canonical = tokio::fs::canonicalize(&file_path).await?;
    let meta = tokio::fs::metadata(&canonical).await?;
    if meta.len() > MAX_CONVERTIBLE_FILE_BYTES {
        return Err(AppError::validation(format!(
            "File too large ({} bytes, max 50MB)",
            meta.len()
        )));
    }
    let allowed_exts = [
        "docx", "pptx", "xlsx", "xls", "csv", "html", "htm", "txt", "md", "json", "xml", "rst",
        "log", "toml", "yaml", "ini", "py", "rs", "js", "ts", "c", "cpp", "go", "java", "pdf",
    ];
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !allowed_exts.contains(&ext.as_str()) {
        return Err(AppError::validation(format!(
            "Unsupported file type: .{ext}"
        )));
    }
    if ext == "pdf" {
        let text = pdf_extract::extract_text(&canonical)
            .map_err(|e| AppError::external(format!("Failed to extract PDF text: {e}")))?;
        return Ok(text);
    }
    let options = anytomd::ConversionOptions::default();
    let result = anytomd::convert_file(&canonical, &options)
        .map_err(|e| AppError::external(e.to_string()))?;
    Ok(result.markdown)
}
