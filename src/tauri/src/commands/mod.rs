//! Tauri commands, organized by domain.
//!
//! Submodules:
//! - [`paths`]: shared ID validation, filename sanitization, canonical-path helpers.
//! - [`session`]: chat session CRUD, attachments.
//! - [`snippets`]: snippet CRUD.
//! - [`settings`]: user settings + OS keychain / dev fallback for secrets.
//! - [`storage`]: `~/.tomat/` tree enumeration and bulk delete.
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
    list_tomat_storage, reveal_tomat_path,
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
    // work_area excludes OS chrome (macOS menu bar, Windows/Linux taskbars/panels);
    // size()/position() include them, which clips the bottom of full-height windows.
    let work_area = monitor.work_area();
    let mon_width = (work_area.size.width as f64 / scale_factor) as u32;
    let mon_height = (work_area.size.height as f64 / scale_factor) as u32;
    let mon_x = (work_area.position.x as f64 / scale_factor) as i32;
    let mon_y = (work_area.position.y as f64 / scale_factor) as i32;

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
    /// Physical-pixel top-left x of the monitor in the global virtual desktop.
    /// Lets the JS side match this xcap monitor against Tauri's
    /// `currentMonitor()` position when launching the region-capture overlay,
    /// without having to rely on monitor names lining up across the two APIs.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
        let x = m.x().unwrap_or(0);
        let y = m.y().unwrap_or(0);
        let width = m.width().unwrap_or(0);
        let height = m.height().unwrap_or(0);
        out.push(CaptureMonitorInfo {
            id,
            name,
            is_primary,
            x,
            y,
            width,
            height,
        });
    }
    Ok(out)
}

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

/// Test whether an accelerator string can be registered as a global shortcut
/// right now. Used by the settings UI to fail-fast when the user picks a
/// combination that's already taken (by Tomat, another app, or the OS) so
/// the bad value never gets persisted.
///
/// Implementation: a transient register → unregister. If registration fails
/// (e.g. the OS or another process owns the combo), the error is propagated.
/// On success, the shortcut is unregistered so this probe doesn't leave any
/// state behind.
#[tauri::command]
pub fn validate_shortcut(app: AppHandle, accelerator: String) -> AppResult<()> {
    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let gs = app.global_shortcut();
    // Probe handler is a no-op; we only care whether registration succeeds.
    match gs.on_shortcut(trimmed, |_, _, _| {}) {
        Ok(()) => {
            let _ = gs.unregister(trimmed);
            Ok(())
        }
        Err(e) => Err(AppError::external(format!(
            "Shortcut '{trimmed}' is already in use or invalid: {e}"
        ))),
    }
}

/// Replace the registered "input mode" shortcuts (file attach, full screen
/// capture, region capture). Pass an empty `bindings` to unregister all of
/// them; typically called when `UserInput` unmounts (e.g. settings opened).
///
/// Empty accelerator strings inside `bindings` are skipped, allowing the user
/// to clear an individual binding without unregistering the others.
#[tauri::command]
pub fn set_input_shortcuts(
    app: AppHandle,
    state: State<AppState>,
    bindings: Vec<(String, String)>,
) -> AppResult<()> {
    let mut current = state
        .0
        .input_shortcuts
        .lock()
        .map_err(|e| AppError::external(format!("input_shortcuts mutex poisoned: {e}")))?;

    // Unregister whatever is currently registered.
    for (_, accel) in current.iter() {
        if !accel.is_empty() {
            let _ = app.global_shortcut().unregister(accel.as_str());
        }
    }
    current.clear();

    // Register each new binding. Failures on individual accelerators are
    // logged but don't abort the others; a conflict on one shortcut
    // shouldn't take the whole input layer down.
    for (event_name, accel) in bindings.into_iter() {
        if accel.trim().is_empty() {
            continue;
        }
        let handle = app.clone();
        let event = event_name.clone();
        let accel_for_register = accel.clone();
        match app.global_shortcut().on_shortcut(
            accel_for_register.as_str(),
            move |_app, _shortcut, evt| {
                if let tauri_plugin_global_shortcut::ShortcutState::Pressed = evt.state {
                    let _ = handle.emit(&format!("input-shortcut-{event}"), ());
                }
            },
        ) {
            Ok(()) => current.push((event_name, accel)),
            Err(e) => {
                eprintln!("[input-shortcut] failed to register '{event_name}' = '{accel}': {e}");
            }
        }
    }

    Ok(())
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

/// Position and size the `region-capture` overlay window over the same
/// monitor the main window is currently on, then show it. Returns the xcap
/// monitor id that matches that monitor (so the JS helper can stash it for
/// `capture_monitor_region` to use).
///
/// All the geometry math lives here rather than in JS because Tauri exposes
/// monitor bounds in physical pixels with a separate scale factor; getting
/// the logical-coordinate conversion right across macOS retina + multi-
/// monitor setups in JS is error-prone.
#[tauri::command]
pub fn show_region_capture_overlay(app: AppHandle) -> AppResult<String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::not_found("Main window missing"))?;
    let target_monitor = main
        .current_monitor()?
        .or(app.primary_monitor()?)
        .ok_or_else(|| AppError::not_found("No monitor available"))?;

    let scale = target_monitor.scale_factor();
    let pos = target_monitor.position();
    let sz = target_monitor.size();
    let logical_x = pos.x as f64 / scale;
    let logical_y = pos.y as f64 / scale;
    let logical_w = sz.width as f64 / scale;
    let logical_h = sz.height as f64 / scale;

    let overlay = app
        .get_webview_window("region-capture")
        .ok_or_else(|| AppError::not_found("region-capture window missing"))?;

    overlay.set_size(Size::Logical(LogicalSize::new(logical_w, logical_h)))?;
    overlay.set_position(Position::Logical(LogicalPosition::new(
        logical_x, logical_y,
    )))?;
    overlay.show()?;
    overlay.set_focus()?;

    // Match the same monitor on the xcap side so the cropping command
    // operates on the same physical pixels we just covered with the overlay.
    // Match by physical position; fall back to the primary monitor.
    let xcap_monitors = xcap::Monitor::all().map_err(|e| AppError::external(e.to_string()))?;
    let mut chosen_id: Option<String> = None;
    for (idx, m) in xcap_monitors.iter().enumerate() {
        let mx = m.x().unwrap_or(0);
        let my = m.y().unwrap_or(0);
        if mx == pos.x && my == pos.y {
            chosen_id = Some(
                m.id()
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| idx.to_string()),
            );
            break;
        }
    }
    if chosen_id.is_none() {
        for (idx, m) in xcap_monitors.iter().enumerate() {
            if m.is_primary().unwrap_or(false) {
                chosen_id = Some(
                    m.id()
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| idx.to_string()),
                );
                break;
            }
        }
    }
    Ok(chosen_id.unwrap_or_else(|| "primary".to_string()))
}

/// Hide the `region-capture` overlay window. Called from the JS helper after
/// the user finishes / cancels selection.
#[tauri::command]
pub fn hide_region_capture_overlay(app: AppHandle) -> AppResult<()> {
    if let Some(overlay) = app.get_webview_window("region-capture") {
        overlay.hide()?;
    }
    Ok(())
}

/// Stash the monitor id the next `capture_monitor_region` should crop
/// against. The region-capture overlay page reads this on mount via
/// `get_region_capture_target` so the overlay knows which xcap monitor to
/// pass back. Set by the JS helper before showing the overlay window.
#[tauri::command]
pub fn set_region_capture_target(state: State<AppState>, monitor_id: String) -> AppResult<()> {
    let mut t =
        state.0.region_capture_target.lock().map_err(|e| {
            AppError::external(format!("region_capture_target mutex poisoned: {e}"))
        })?;
    *t = monitor_id;
    Ok(())
}

/// Read the monitor id stashed by `set_region_capture_target`. Returns
/// "primary" when nothing has been set yet.
#[tauri::command]
pub fn get_region_capture_target(state: State<AppState>) -> AppResult<String> {
    let t =
        state.0.region_capture_target.lock().map_err(|e| {
            AppError::external(format!("region_capture_target mutex poisoned: {e}"))
        })?;
    Ok(t.clone())
}

/// Capture a rectangular region of the named monitor and return a
/// base64-encoded PNG. Coordinates are physical pixels relative to the
/// monitor's top-left. Out-of-bounds rectangles are clamped to the monitor.
#[tauri::command]
pub async fn capture_monitor_region(
    monitor_id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> AppResult<String> {
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

    let img_w = image.width();
    let img_h = image.height();
    // Clamp the rect to the monitor's physical bounds.
    let crop_x = x.max(0) as u32;
    let crop_y = y.max(0) as u32;
    let crop_x = crop_x.min(img_w);
    let crop_y = crop_y.min(img_h);
    let crop_w = width.min(img_w.saturating_sub(crop_x));
    let crop_h = height.min(img_h.saturating_sub(crop_y));
    if crop_w == 0 || crop_h == 0 {
        return Err(AppError::external("Region has zero area".to_string()));
    }

    let dyn_img = image::DynamicImage::ImageRgba8(image).crop_imm(crop_x, crop_y, crop_w, crop_h);
    let mut buf: Vec<u8> = Vec::new();
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
