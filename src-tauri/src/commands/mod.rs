//! Tauri commands, organized by domain.
//!
//! Submodules:
//! - [`paths`] — shared ID validation, filename sanitization, canonical-path helpers.
//! - [`session`] — chat session CRUD, attachments.
//! - [`snippets`] — snippet CRUD.
//! - [`settings`] — user settings + OS keychain / dev fallback for secrets.
//! - [`storage`] — `~/.tomat/` tree enumeration and bulk delete.
//!
//! Everything else (window management, monitor capture, sidecar control,
//! process metrics, file conversion) lives directly in this file.

pub mod paths;
pub mod session;
pub mod settings;
pub mod snippets;
pub mod storage;

// Re-export the Tauri command fns so `use crate::commands::*;` in `lib.rs`
// pulls in everything needed by `tauri::generate_handler!`.
pub use session::{
    delete_chat_session, delete_session_attachments, list_chat_sessions, load_chat_session,
    load_latest_chat_history, read_session_attachment, save_chat_history, save_session_title,
    write_session_attachment,
};
pub use settings::{load_settings, save_settings};
pub use snippets::{delete_snippet, list_snippets, save_snippet};
pub use storage::{
    clear_tomat_models, clear_tomat_sessions, clear_tomat_settings, delete_tomat_paths,
    list_tomat_storage,
};

use crate::error::{AppError, AppResult};
use crate::sidecar::{
    emit_status, ensure_path_internal, start_bun_sidecar, update_server_args_internal,
};
use crate::state::AppState;
use crate::types::{ServerStatus, WindowAlignment};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, State};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

fn resolve_monitor(app: &AppHandle, monitor_id: &str) -> AppResult<tauri::Monitor> {
    let all_monitors = app.available_monitors()?;
    let primary_monitor = app.primary_monitor()?;

    let monitor = if monitor_id == "primary" {
        primary_monitor
    } else {
        all_monitors
            .iter()
            .find(|mon| {
                mon.name()
                    .map(|name| name.as_str() == monitor_id || name.contains(monitor_id))
                    .unwrap_or(false)
            })
            .cloned()
            .or_else(|| {
                monitor_id
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| all_monitors.get(index).cloned())
            })
            .or(primary_monitor)
    };

    monitor.ok_or_else(|| AppError::not_found("No monitor available"))
}

/// Move and resize the main window to fill the chosen monitor with the given alignment.
#[tauri::command]
pub fn position_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    monitor_id: String,
    alignment: WindowAlignment,
    width: Option<u32>,
) -> AppResult<()> {
    let monitor = resolve_monitor(&app, &monitor_id)?;
    let scale_factor = monitor.scale_factor();
    let mon_width = (monitor.size().width as f64 / scale_factor) as u32;
    let mon_height = (monitor.size().height as f64 / scale_factor) as u32;
    let mon_x = (monitor.position().x as f64 / scale_factor) as i32;
    let mon_y = (monitor.position().y as f64 / scale_factor) as i32;

    let width: u32 = width.unwrap_or(700).clamp(400, 1200);

    let mut x = mon_x;
    match alignment {
        WindowAlignment::Left => {}
        WindowAlignment::Center => {
            x += ((mon_width.saturating_sub(width)) / 2) as i32;
        }
        WindowAlignment::Right => {
            x += mon_width.saturating_sub(width) as i32;
        }
    }

    window.set_size(Size::Logical(LogicalSize::new(
        width as f64,
        mon_height as f64,
    )))?;
    window.set_position(Position::Logical(LogicalPosition::new(
        x as f64,
        mon_y as f64,
    )))?;

    Ok(())
}

/// Show the main window, focus it, and broadcast a `window-visibility: true` event.
#[tauri::command]
pub fn show_main_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> AppResult<()> {
    window.show()?;
    window.set_focus()?;
    state
        .0
        .visible
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("window-visibility", true);
    Ok(())
}

/// Hide the main window and broadcast a `window-visibility: false` event.
#[tauri::command]
pub fn hide_main_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> AppResult<()> {
    window.hide()?;
    state
        .0
        .visible
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("window-visibility", false);
    Ok(())
}

/// Ask the frontend to play its slide-out animation and then hide the window
/// by invoking `hide_main_window`. Use this instead of `hide_main_window`
/// when the request is user-initiated (shortcut, tray) so the UI gets a
/// chance to animate before the native window disappears.
#[tauri::command]
pub fn request_hide_main_window(app: AppHandle) -> AppResult<()> {
    let _ = app.emit("window-hide-requested", ());
    Ok(())
}

/// Toggle the main window's visibility using the same shared `AtomicBool` the
/// tray icon uses, so the global shortcut and the tray click are guaranteed
/// to behave identically.
#[tauri::command]
pub fn toggle_main_window(app: AppHandle, state: State<AppState>) -> AppResult<()> {
    crate::toggle_window(&app, &state.0.visible);
    Ok(())
}

/// Replace the currently registered show / hide window global shortcut. Pass
/// `None` (or an empty string) to unregister and leave the shortcut disabled;
/// the tray icon still toggles the window in that case.
///
/// Idempotent when the requested accelerator already matches the registered
/// one, and best-effort rolls back to the previous accelerator if the new one
/// fails to register (e.g. when another app or the OS already owns it).
#[tauri::command]
pub fn set_global_shortcut(
    app: AppHandle,
    state: State<AppState>,
    accelerator: Option<String>,
) -> AppResult<()> {
    let new_value = accelerator.and_then(|s| {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    let mut current = state
        .0
        .current_shortcut
        .lock()
        .map_err(|e| AppError::external(format!("shortcut mutex poisoned: {e}")))?;

    if *current == new_value {
        return Ok(());
    }

    let prev = current.clone();

    if let Some(prev_str) = prev.as_ref() {
        let _ = app.global_shortcut().unregister(prev_str.as_str());
    }
    *current = None;

    let Some(new_str) = new_value else {
        return Ok(());
    };

    match crate::register_toggle_shortcut(&app, &new_str) {
        Ok(()) => {
            *current = Some(new_str);
            Ok(())
        }
        Err(e) => {
            if let Some(prev_str) = prev {
                if crate::register_toggle_shortcut(&app, &prev_str).is_ok() {
                    *current = Some(prev_str);
                }
            }
            Err(AppError::external(format!(
                "Failed to register shortcut '{new_str}': {e}"
            )))
        }
    }
}

#[derive(serde::Serialize)]
pub struct CaptureMonitorInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "isPrimary")]
    pub is_primary: bool,
}

/// List attached monitors for the screen-capture picker.
#[tauri::command]
pub async fn list_capture_monitors() -> AppResult<Vec<CaptureMonitorInfo>> {
    let monitors = xcap::Monitor::all().map_err(|e| AppError::external(e.to_string()))?;
    let mut out = Vec::new();
    for (idx, m) in monitors.iter().enumerate() {
        let id = m
            .id()
            .map(|v| v.to_string())
            .unwrap_or_else(|_| idx.to_string());
        let name = m.name().unwrap_or_else(|_| format!("Monitor {}", idx + 1));
        let is_primary = m.is_primary().unwrap_or(false);
        out.push(CaptureMonitorInfo {
            id,
            name,
            is_primary,
        });
    }
    Ok(out)
}

/// Capture the named monitor and return a base64-encoded PNG.
#[tauri::command]
pub async fn capture_monitor(monitor_id: String) -> AppResult<String> {
    use base64::Engine;
    let monitors = xcap::Monitor::all().map_err(|e| AppError::external(e.to_string()))?;
    let monitor = monitors
        .into_iter()
        .enumerate()
        .find(|(idx, m)| {
            m.id()
                .ok()
                .map(|v| v.to_string() == monitor_id)
                .unwrap_or(false)
                || idx.to_string() == monitor_id
        })
        .map(|(_, m)| m)
        .ok_or_else(|| AppError::not_found("Monitor not found"))?;

    let image = monitor
        .capture_image()
        .map_err(|e| AppError::external(e.to_string()))?;

    let mut buf: Vec<u8> = Vec::new();
    let dyn_img = image::DynamicImage::ImageRgba8(image);
    dyn_img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

/// Return a snapshot of each tracked sidecar's status. Used on startup
/// when the frontend reconciles against any already-running processes.
#[tauri::command]
pub async fn get_server_statuses(
    state: State<'_, AppState>,
) -> AppResult<HashMap<String, ServerStatus>> {
    let sidecars = state
        .0
        .sidecars
        .lock()
        .map_err(|e| AppError::sidecar(format!("sidecar mutex poisoned: {e}")))?;
    let mut statuses = HashMap::new();
    for (name, _) in sidecars.iter() {
        statuses.insert(name.clone(), ServerStatus::Running);
    }
    Ok(statuses)
}

/// Download the named Hugging Face paths into the shared model cache, emitting
/// progress events on the given sidecar's status channel. Restores the
/// `Running` status when finished so the chip returns to its idle state.
#[tauri::command]
pub async fn ensure_models(
    handle: AppHandle,
    state: State<'_, AppState>,
    server: String,
    paths: Vec<String>,
) -> AppResult<()> {
    let result = async {
        for path in &paths {
            ensure_path_internal(&handle, state.inner(), &server, path).await?;
        }
        Ok::<(), AppError>(())
    }
    .await;

    match &result {
        Ok(_) => {
            emit_status(&handle, &server, ServerStatus::Running, None, None).await;
        }
        Err(e) => {
            emit_status(
                &handle,
                &server,
                ServerStatus::Error,
                None,
                Some(e.to_string()),
            )
            .await;
        }
    }

    result
}

/// Recycle the bun sidecar process. Used by the TTS toggle to free the ORT
/// session memory: in-process disposal works but the OS allocator keeps freed
/// pages mapped to the process, so RSS only visibly drops when the process
/// itself is replaced. The bun sidecar always stays running (it also hosts
/// upcoming tools), this just reincarnates it with a fresh heap.
#[tauri::command]
pub async fn restart_bun_sidecar(handle: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    start_bun_sidecar(handle, state.inner()).await
}

/// (Re)launch a sidecar with the given args. Supersedes any previous instance.
#[tauri::command]
pub async fn update_server_args(
    handle: AppHandle,
    state: State<'_, AppState>,
    server: String,
    args: Vec<String>,
    model_path: Option<String>,
    mmproj_path: Option<String>,
    check_url: Option<String>,
) -> AppResult<()> {
    update_server_args_internal(
        handle,
        state.inner(),
        server,
        args,
        model_path,
        mmproj_path,
        check_url,
    )
    .await
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

