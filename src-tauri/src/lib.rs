mod commands;
mod error;
mod sidecar;
mod sidecar_kind;
mod state;
mod types;
mod utils;

use crate::commands::*;
use crate::sidecar::{init_process_guards, kill_all_sidecars, probe_downloads, start_bun_sidecar};
use crate::state::{AppState, AppStateInner, MAX_CONCURRENT_DOWNLOADS};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Default global shortcut applied at startup before the frontend pushes the
/// persisted value. Kept here so both `lib.rs` setup and any reset path can
/// reference one source of truth.
pub const DEFAULT_TOGGLE_SHORTCUT: &str = "super+ctrl+shift+z";

/// Register the show / hide window global shortcut, emitting `shortcut-pressed`
/// and `shortcut-released` so the frontend owns the toggle / push-to-talk
/// semantics.
pub fn register_toggle_shortcut(
    app: &AppHandle,
    accelerator: &str,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(accelerator, move |_app, _shortcut, event| {
            match event.state {
                ShortcutState::Pressed => {
                    let _ = handle.emit("shortcut-pressed", ());
                }
                ShortcutState::Released => {
                    let _ = handle.emit("shortcut-released", ());
                }
            }
        })
}

/// Toggle the main window's visibility, keeping the shared `AtomicBool` in
/// sync. Returns the new visibility *intent*. Used by the tray, the tray menu,
/// and the global-shortcut handler so they all share one source of truth.
///
/// Hide is deferred: we emit `window-hide-requested` and leave the native
/// window visible so the frontend can play its slide-out animation first.
/// The frontend invokes `hide_main_window` when the animation completes.
pub fn toggle_window(app: &AppHandle, visible: &AtomicBool) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        if visible.load(Ordering::Relaxed) {
            let _ = app.emit("window-hide-requested", ());
            // Intent: about to hide. Actual `visible=false` is set by
            // `hide_main_window` after the animation completes.
            false
        } else {
            let _ = window.show();
            let _ = window.set_focus();
            visible.store(true, Ordering::Relaxed);
            let _ = app.emit("window-visibility", true);
            true
        }
    } else {
        visible.load(Ordering::Relaxed)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// Two .expect() sites in this fn are intentional startup panics on
// unrecoverable bundle/runtime errors; see the inline comments.
#[allow(clippy::expect_used)]
pub fn run() {
    let last_monitor: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let move_last_monitor = last_monitor.clone();

    tauri::Builder::default()
        .manage(AppState(Arc::new(AppStateInner {
            sidecars: Mutex::new(HashMap::new()),
            download_sem: tokio::sync::Semaphore::new(MAX_CONCURRENT_DOWNLOADS),
            metrics: tokio::sync::RwLock::new(sysinfo::System::new()),
            current_shortcut: Mutex::new(None),
            visible: AtomicBool::new(true),
        })))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    state.0.visible.store(false, Ordering::Relaxed);
                }
                let _ = window.app_handle().emit("window-visibility", false);
                api.prevent_close();
            }
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                let _ = window.app_handle().emit("monitor-changed", ());
            }
            tauri::WindowEvent::Moved(_) => {
                if let Ok(Some(mon)) = window.current_monitor() {
                    let name = mon.name().cloned();
                    if let Ok(mut last) = move_last_monitor.lock() {
                        if *last != name {
                            *last = name;
                            let _ = window.app_handle().emit("monitor-changed", ());
                        }
                    }
                }
            }
            _ => {}
        })
        .setup(move |app| {
            // On Windows, create a kill-on-close Job Object so sidecars are
            // terminated automatically if this process exits for any reason
            // (Ctrl+C, crash). On other platforms this is a no-op.
            init_process_guards();

            // Hide dock icon on macOS
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Tray menu: toggle display + exit
            let toggle_item =
                MenuItem::with_id(app, "toggle_display", "Hide Display", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&toggle_item, &exit_item])?;

            // Tray icon: left-click toggles window, right-click shows menu
            let tray_toggle_item = toggle_item.clone();
            let menu_toggle_item = toggle_item.clone();

            tauri::tray::TrayIconBuilder::new()
                .icon(
                    // Intentional panic on startup: a missing tray icon means
                    // the bundle is broken; the app cannot recover.
                    app.default_window_icon()
                        .expect("tray icon must be bundled")
                        .clone(),
                )
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(move |tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(state) = app.try_state::<AppState>() {
                            let is_visible = toggle_window(app, &state.0.visible);
                            let _ = tray_toggle_item.set_text(if is_visible {
                                "Hide tomat"
                            } else {
                                "Show tomat"
                            });
                        }
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "toggle_display" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            let is_visible = toggle_window(app, &state.0.visible);
                            let _ = menu_toggle_item.set_text(if is_visible {
                                "Hide tomat"
                            } else {
                                "Show tomat"
                            });
                        }
                    }
                    "exit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Global shortcut: starts out on DEFAULT_TOGGLE_SHORTCUT so the app is
            // usable before the frontend has loaded settings. Once settings.json
            // is read on the JS side, `set_global_shortcut` replaces this with
            // the user's configured value (or unregisters it entirely).
            // The frontend owns the semantics (hide/show/VAD toggle) based on
            // the Smart STT setting, so Rust only emits press/release events.
            register_toggle_shortcut(app.handle(), DEFAULT_TOGGLE_SHORTCUT)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            {
                let state: State<AppState> = app.state();
                let app_state = state.inner().clone();
                let lock_result = app_state.0.current_shortcut.lock();
                if let Ok(mut current) = lock_result {
                    *current = Some(DEFAULT_TOGGLE_SHORTCUT.to_string());
                }
            }

            // Initial Sidecars
            let handle = app.handle().clone();
            let state: State<AppState> = app.state();
            let app_state = state.inner().clone();

            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_bun_sidecar(handle.clone(), &app_state).await {
                    eprintln!("[startup] start_bun_sidecar: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_statuses,
            update_server_args,
            restart_bun_sidecar,
            ensure_models,
            position_window,
            show_main_window,
            hide_main_window,
            request_hide_main_window,
            toggle_main_window,
            set_global_shortcut,
            list_capture_monitors,
            capture_monitor,
            resolve_path,
            save_settings,
            load_settings,
            save_chat_history,
            load_latest_chat_history,
            list_chat_sessions,
            save_session_title,
            load_chat_session,
            delete_chat_session,
            write_session_attachment,
            read_session_attachment,
            delete_session_attachments,
            convert_file_to_markdown,
            probe_downloads,
            get_process_metrics,
            list_tomat_storage,
            delete_tomat_paths,
            clear_tomat_models,
            clear_tomat_sessions,
            clear_tomat_settings,
            save_snippet,
            list_snippets,
            delete_snippet
        ])
        .build(tauri::generate_context!())
        // Intentional panic on startup: Tauri runtime failure is unrecoverable.
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    kill_all_sidecars(&state);
                }
            }
        });
}
