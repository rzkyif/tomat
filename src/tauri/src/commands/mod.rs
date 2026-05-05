//! Tauri commands, organized by domain.
//!
//! Submodules:
//! - [`paths`]: shared ID validation, filename sanitization, canonical-path helpers.
//! - [`session`]: chat session CRUD, attachments.
//! - [`snippets`]: snippet CRUD.
//! - [`settings`]: user settings + OS keychain / dev fallback for secrets.
//! - [`storage`]: `~/.tomat/` tree enumeration and bulk delete.
//! - [`window`]: main-window visibility, positioning, global / input shortcuts.
//! - [`capture`]: monitor enumeration, full-monitor capture, region-capture overlay.
//! - [`servers`]: sidecar status, model fetch, restart, arg replacement.
//!
//! Misc top-level commands that haven't grown enough to warrant their own
//! module (system volume, file conversion, process metrics, toolkit folder
//! ops, path resolution, downloads-dir lookup) live directly in this file.

pub mod capture;
pub mod paths;
pub mod servers;
pub mod session;
pub mod settings;
pub mod snippets;
pub mod storage;
pub mod window;

// Re-export the Tauri command fns so `use crate::commands::*;` in `lib.rs`
// pulls in everything needed by `tauri::generate_handler!`.
pub use capture::{
    capture_monitor, capture_monitor_region, get_region_capture_target,
    hide_region_capture_overlay, list_capture_monitors, set_region_capture_target,
    show_region_capture_overlay,
};
pub use servers::{ensure_models, get_server_statuses, restart_bun_sidecar, update_server_args};
pub use session::{
    delete_chat_session, delete_session_attachments, list_chat_sessions, load_chat_session,
    load_latest_chat_history, read_session_attachment, save_chat_history, save_session_title,
    write_session_attachment,
};
pub use settings::{load_settings, save_settings};
pub use snippets::{delete_snippet, list_snippets, save_snippet};
pub use storage::{
    clear_tomat_models, clear_tomat_sessions, clear_tomat_settings, delete_tomat_paths,
    list_tomat_storage, reveal_tomat_path,
};
pub use window::{
    hide_main_window, position_window, request_hide_main_window, set_global_shortcut,
    set_input_shortcuts, show_main_window, toggle_main_window, validate_shortcut,
};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

/// Read the default output device's master volume as a 0–100 percent value.
/// Returns 0 if `cpvc` cannot read the device (e.g. no audio hardware).
#[tauri::command]
pub async fn get_system_volume() -> AppResult<u8> {
    Ok(cpvc::get_system_volume())
}

/// Lower the system volume to `percent` of its current value for the duration
/// of an STT listening session, capturing the original level into
/// `state.saved_volume` so it can be restored later.
///
/// `percent` is interpreted relatively (e.g. `25` = 25 % of whatever the
/// system was already at). The original (pre-listening) level is captured
/// only on the first call of a session; subsequent calls compute the new
/// target against that captured baseline, so changing the target mid-session
/// remains anchored to the original level rather than compounding against
/// the lowered one.
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
    // Round half-to-nearest (saturates at u8 by clamping). e.g. baseline=25,
    // percent=10 → 2.5 → 3. baseline=50, percent=20 → 10.
    let target = (((baseline as u32) * (percent as u32) + 50) / 100).min(100) as u8;
    if !cpvc::set_system_volume(target) {
        return Err(AppError::external(
            "Failed to set system volume via cpvc".to_string(),
        ));
    }
    Ok(())
}

/// Restore the previously-captured system volume (set by `set_system_volume`).
/// No-op when nothing is owed.
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
// File conversion (anytomd)
// -------------------------------------------------------------------

/// Maximum file size accepted by `convert_file_to_markdown`. Capped so a
/// pathological attachment can't trigger a multi-GB in-memory conversion.
const MAX_CONVERTIBLE_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Convert the file at `file_path` to Markdown for attachment as document context.
/// Size-capped at 50 MiB; extension-whitelisted.
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

// -------------------------------------------------------------------
// Process metrics
// -------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct ProcessMetrics {
    pub pid: u32,
    pub rss_mb: f64,
    pub cpu_pct: f32,
    pub running: bool,
}

/// Return RSS and CPU% for each tracked sidecar plus the main process.
#[tauri::command]
pub async fn get_process_metrics(
    state: State<'_, AppState>,
) -> AppResult<HashMap<String, ProcessMetrics>> {
    let mut pids: Vec<(String, u32)> = {
        let sidecars = state
            .0
            .sidecars
            .lock()
            .map_err(|e| AppError::sidecar(format!("sidecar mutex poisoned: {e}")))?;
        sidecars
            .iter()
            .filter_map(|(name, s)| s.pid.map(|pid| (name.clone(), pid)))
            .collect()
    };

    if let Ok(main_pid) = sysinfo::get_current_pid() {
        pids.push(("main".to_string(), main_pid.as_u32()));
    }

    let mut out = HashMap::new();
    let mut sys = state.0.metrics.write().await;
    for (name, pid) in pids {
        let sys_pid = sysinfo::Pid::from_u32(pid);
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sys_pid]), true);
        if let Some(proc) = sys.process(sys_pid) {
            out.insert(
                name,
                ProcessMetrics {
                    pid,
                    rss_mb: proc.memory() as f64 / 1024.0 / 1024.0,
                    cpu_pct: proc.cpu_usage(),
                    running: true,
                },
            );
        } else {
            out.insert(
                name,
                ProcessMetrics {
                    pid,
                    rss_mb: 0.0,
                    cpu_pct: 0.0,
                    running: false,
                },
            );
        }
    }
    Ok(out)
}

// -------------------------------------------------------------------
// Toolkits
// -------------------------------------------------------------------

async fn toolkits_dir(handle: &AppHandle) -> AppResult<std::path::PathBuf> {
    let home = handle.path().home_dir()?;
    let dir = home.join(".tomat").join("toolkits");
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

/// Open the `~/.tomat/toolkits/` folder in the user's file manager. Creates
/// the folder first if it doesn't exist so the Settings UI can wire this to
/// a button that's always usable.
#[tauri::command]
pub async fn open_toolkits_folder(handle: AppHandle) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = toolkits_dir(&handle).await?;
    handle
        .opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::external(e.to_string()))
}

/// Open a specific toolkit file or folder in the user's file manager. Id
/// matches the filesystem entry name; path is canonicalized and must resolve
/// under `~/.tomat/toolkits/`.
#[tauri::command]
pub async fn open_toolkit_entry(handle: AppHandle, id: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let root = toolkits_dir(&handle).await?;
    let root_canon = root.canonicalize()?;
    let candidate_file = root.join(format!("{id}.ts"));
    let candidate_dir = root.join(&id);
    let target = if candidate_dir.exists() {
        candidate_dir
    } else if candidate_file.exists() {
        candidate_file
    } else {
        return Err(AppError::not_found(format!(
            "toolkit entry not found: {id}"
        )));
    };
    let canonical = paths::resolve_within(&target, &root_canon)
        .ok_or_else(|| AppError::validation("invalid toolkit path"))?;
    handle
        .opener()
        .open_path(canonical.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::external(e.to_string()))
}

/// Seed `~/.tomat/toolkits/` with bundled sample toolkits and the
/// `toolkits.d.ts` SDK file on first run. Existing entries with the same
/// name are left untouched. Returns the ids actually seeded.
#[tauri::command]
pub async fn seed_sample_toolkits(handle: AppHandle) -> AppResult<Vec<String>> {
    let dest_root = toolkits_dir(&handle).await?;

    let resources_root = handle.path().resource_dir()?.join("toolkits");

    if !resources_root.exists() {
        return Ok(vec![]);
    }

    let mut seeded: Vec<String> = Vec::new();

    let sdk_src = resources_root.join("toolkits.d.ts");
    if sdk_src.exists() {
        let sdk_dst = dest_root.join("toolkits.d.ts");
        let _ = tokio::fs::copy(&sdk_src, sdk_dst).await;
    }

    let mut reader = match tokio::fs::read_dir(&resources_root).await {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };

    while let Some(entry) = reader.next_entry().await? {
        let p = entry.path();
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if name == "toolkits.d.ts" {
            continue;
        }
        let dst = dest_root.join(&name);
        if dst.exists() {
            continue;
        }
        let meta = entry.metadata().await?;
        if meta.is_dir() {
            if let Err(e) = copy_dir_recursive(&p, &dst).await {
                eprintln!("[toolkits] failed to seed {name}: {e}");
                continue;
            }
            seeded.push(name);
        } else if meta.is_file() && name.ends_with(".ts") {
            if let Err(e) = tokio::fs::copy(&p, &dst).await {
                eprintln!("[toolkits] failed to seed {name}: {e}");
                continue;
            }
            let id = name.trim_end_matches(".ts").to_string();
            seeded.push(id);
        }
    }

    Ok(seeded)
}

async fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;
    let mut reader = tokio::fs::read_dir(src).await?;
    while let Some(entry) = reader.next_entry().await? {
        let file_type = entry.file_type().await?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            Box::pin(copy_dir_recursive(&from, &to)).await?;
        } else if file_type.is_file() {
            tokio::fs::copy(&from, &to).await?;
        }
    }
    Ok(())
}

/// Resolve the platform's default Downloads directory. Used by the
/// `download_url` sample toolkit.
#[tauri::command]
pub async fn downloads_dir(handle: AppHandle) -> AppResult<String> {
    if let Some(p) = dirs::download_dir() {
        return Ok(p.to_string_lossy().to_string());
    }
    let home = handle.path().home_dir()?;
    Ok(home.join("Downloads").to_string_lossy().to_string())
}
