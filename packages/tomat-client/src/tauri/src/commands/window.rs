//! Window management, global shortcuts, and input-mode shortcuts.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::types::WindowAlignment;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Position, Size, State};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub fn resolve_monitor(app: &AppHandle, monitor_id: &str) -> AppResult<tauri::Monitor> {
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
