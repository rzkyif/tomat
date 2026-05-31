mod channel;
mod commands;
mod error;
mod state;
mod types;

use crate::commands::*;
use crate::state::{AppState, AppStateInner};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Default global shortcut applied at startup before the frontend pushes the
/// persisted value.
pub const DEFAULT_TOGGLE_SHORTCUT: &str = "super+ctrl+shift+z";

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

pub fn toggle_window(app: &AppHandle, visible: &AtomicBool) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        if visible.load(Ordering::Relaxed) {
            let _ = app.emit("window-hide-requested", ());
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
#[allow(clippy::expect_used)]
pub fn run() {
    let last_monitor: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let move_last_monitor = last_monitor.clone();

    tauri::Builder::default()
        .manage(AppState(Arc::new(AppStateInner {
            current_shortcut: Mutex::new(None),
            visible: AtomicBool::new(true),
            saved_volume: Mutex::new(None),
            input_shortcuts: Mutex::new(Vec::new()),
            region_capture_target: Mutex::new("primary".to_string()),
            install_in_progress: AtomicBool::new(false),
            install_last_finished_ms: AtomicI64::new(0),
        })))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let toggle_item =
                MenuItem::with_id(app, "toggle_display", "Hide Display", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&toggle_item, &exit_item])?;

            let tray_toggle_item = toggle_item.clone();
            let menu_toggle_item = toggle_item.clone();

            tauri::tray::TrayIconBuilder::new()
                .icon(
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Window + shortcuts
            position_window,
            show_main_window,
            hide_main_window,
            request_hide_main_window,
            toggle_main_window,
            set_global_shortcut,
            set_input_shortcuts,
            validate_shortcut,
            // Capture
            list_capture_monitors,
            capture_monitor,
            capture_monitor_region,
            set_region_capture_target,
            get_region_capture_target,
            show_region_capture_overlay,
            hide_region_capture_overlay,
            // System
            list_system_fonts,
            get_system_volume,
            set_system_volume,
            restore_system_volume,
            resolve_path,
            convert_file_to_markdown,
            // Pairing / admin
            read_admin_token,
            install_local_core,
            local_core_installed,
            local_core_base_url,
            local_sidecar_ports,
            start_local_core,
            // Client settings + keychain
            read_client_settings,
            write_client_settings,
            keychain_set_token,
            keychain_get_token,
            keychain_delete_token,
            // Pinned core networking
            net_fetch,
            net_ws_open,
            net_ws_send,
            net_ws_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Best-effort: unregister the OS-level global shortcut so
                // the OS doesn't keep our binding alive across an immediate
                // relaunch (which would race the new instance's register
                // call). The shortcut plugin already cleans up on plugin
                // shutdown, but explicit unregister here makes the
                // sequence predictable.
                let _ = app_handle.global_shortcut().unregister_all();
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut saved) = state.0.saved_volume.lock() {
                        if let Some(v) = saved.take() {
                            let _ = cpvc::set_system_volume(v);
                        }
                    }
                }
            }
        });
}
