mod commands;
mod sidecar;
mod state;
mod types;
mod utils;

use crate::commands::*;
use crate::sidecar::{probe_downloads, update_server_args_internal};
use crate::state::{AppState, AppStateInner};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn toggle_window(app: &AppHandle, visible: &AtomicBool) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        if visible.load(Ordering::Relaxed) {
            let _ = window.hide();
            visible.store(false, Ordering::Relaxed);
            let _ = app.emit("window-visibility", false);
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
pub fn run() {
    let visible = Arc::new(AtomicBool::new(true));
    let close_visible = visible.clone();

    tauri::Builder::default()
        .manage(AppState(Arc::new(AppStateInner {
            sidecars: Mutex::new(HashMap::new()),
            download_mutex: tokio::sync::Mutex::new(()),
            metrics: Mutex::new(sysinfo::System::new()),
        })))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                close_visible.store(false, Ordering::Relaxed);
                api.prevent_close();
            }
        })
        .setup(move |app| {
            // Hide dock icon on macOS
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Tray menu: toggle display + exit
            let toggle_item =
                MenuItem::with_id(app, "toggle_display", "Hide Display", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&toggle_item, &exit_item])?;

            // Tray icon: left-click toggles window, right-click shows menu
            let tray_visible = visible.clone();
            let tray_toggle_item = toggle_item.clone();
            let menu_visible = visible.clone();
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
                        let is_visible = toggle_window(tray.app_handle(), &tray_visible);
                        let _ = tray_toggle_item.set_text(if is_visible {
                            "Hide tomat"
                        } else {
                            "Show tomat"
                        });
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "toggle_display" => {
                        let is_visible = toggle_window(app, &menu_visible);
                        let _ = menu_toggle_item.set_text(if is_visible {
                            "Hide tomat"
                        } else {
                            "Show tomat"
                        });
                    }
                    "exit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Global shortcut: Meta+Shift+Ctrl+Z.
            // The frontend owns the semantics (hide/show/VAD toggle) based on the
            // Smart STT setting, so Rust only emits press/release events here.
            let shortcut_handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut("super+ctrl+shift+z", move |_app, _shortcut, event| {
                    match event.state {
                        ShortcutState::Pressed => {
                            let _ = shortcut_handle.emit("shortcut-pressed", ());
                        }
                        ShortcutState::Released => {
                            let _ = shortcut_handle.emit("shortcut-released", ());
                        }
                    }
                })
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            // Initial Sidecars
            let handle = app.handle().clone();
            let state: State<AppState> = app.state();
            let app_state = state.inner().clone();

            tauri::async_runtime::spawn(async move {
                let resources_path = match handle.path().resource_dir() {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("[startup] resource_dir: {e}");
                        return;
                    }
                };
                let server_js_path = resources_path.join("resources").join("server.js");

                let _ = update_server_args_internal(
                    handle.clone(),
                    &app_state,
                    "bun".to_string(),
                    vec![
                        "run".to_string(),
                        server_js_path.to_string_lossy().to_string(),
                    ],
                    None,
                    None,
                    Some("http://localhost:7703/api/health".to_string()),
                )
                .await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_statuses,
            update_server_args,
            position_window,
            show_main_window,
            hide_main_window,
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
            convert_file_to_markdown,
            probe_downloads,
            get_process_metrics,
            list_tomat_storage,
            delete_tomat_paths,
            clear_tomat_models,
            clear_tomat_sessions,
            clear_tomat_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
