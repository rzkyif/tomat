// The mobile shell legitimately leaves many desktop-oriented helpers and
// AppState fields unused (shortcuts, volume, region capture, window state), so
// suppress dead-code noise on mobile only; desktop keeps full dead-code checks.
#![cfg_attr(mobile, allow(dead_code))]

mod channel;
mod commands;
mod error;
mod logging;
mod state;
mod types;

use crate::commands::*;
use crate::logging::client_log;
use crate::state::{AppState, AppStateInner};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32};
use std::sync::{Arc, Mutex};

#[cfg(desktop)]
use std::sync::atomic::Ordering;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Shared app state. The desktop-only fields (shortcut, volume, region-capture,
/// install guards) are simply unused on mobile, so one constructor serves both
/// the desktop and mobile builders.
fn new_app_state() -> AppState {
    AppState(Arc::new(AppStateInner {
        current_shortcut: Mutex::new(None),
        // The window is created hidden (`visible: false` in tauri.conf.json)
        // and revealed by the frontend on boot (or via the tray/shortcut).
        // Track it as hidden to match, so toggle_window() shows it on the
        // first press even when the frontend never reached its show() call.
        // On mobile this field is unused (the single activity is always shown).
        visible: AtomicBool::new(false),
        saved_volume: Mutex::new(None),
        input_shortcuts: Mutex::new(Vec::new()),
        region_capture_target: Mutex::new("primary".to_string()),
        install_in_progress: AtomicBool::new(false),
        install_last_finished_ms: AtomicI64::new(0),
        spawned_core_pid: AtomicU32::new(0),
    }))
}

/// Default global shortcut applied at startup before the frontend pushes the
/// persisted value. Desktop only (no OS-level global hotkeys on mobile). Windows
/// gets a `super`-free combo because `super` is the OS-reserved Win key there,
/// which `RegisterHotKey` accepts but Windows silently swallows; kept in sync
/// with the shared per-platform default in settings state (setPlatformDefaults),
/// which the frontend re-asserts over this on load. Elsewhere `super` = Cmd.
#[cfg(all(desktop, windows))]
pub const DEFAULT_TOGGLE_SHORTCUT: &str = "ctrl+alt+shift+z";
#[cfg(all(desktop, not(windows)))]
pub const DEFAULT_TOGGLE_SHORTCUT: &str = "super+ctrl+shift+z";

#[cfg(desktop)]
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

#[cfg(desktop)]
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
pub fn run() {
    // First thing: stand up logging so even Builder/plugin init is captured.
    // Android has no $HOME to derive the file-sink path from and needs an
    // AppHandle, so its logger is initialized later in run_mobile's setup().
    #[cfg(desktop)]
    {
        logging::init();
        log::info!(target: "tomat::boot", "tomat Client starting (channel={})", crate::channel::channel());
    }

    // Register the OS keychain as keyring-core's default store before any
    // paired-core token op. Non-fatal: the dev build uses a file store, and a
    // real failure surfaces cleanly when a keychain command runs. On android
    // this is a no-op (tokens go to an app-private file; see keychain.rs).
    if let Err(e) = init_default_store() {
        log::warn!(target: "tomat::boot", "keychain store init failed: {e}");
    }

    #[cfg(desktop)]
    run_desktop();
    #[cfg(mobile)]
    run_mobile();
}

/// Desktop shell: transparent always-on-top bubble window, tray icon, global
/// toggle shortcut, and the full desktop command set.
#[cfg(desktop)]
#[allow(clippy::expect_used)]
fn run_desktop() {
    let last_monitor: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let move_last_monitor = last_monitor.clone();

    tauri::Builder::default()
        .manage(new_app_state())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
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
            client_channel,
            can_self_install,
            convert_file_to_markdown,
            get_self_metrics,
            was_autostarted,
            get_client_storage,
            truncate_client_log,
            // Pairing / admin
            read_admin_token,
            read_local_core_boot_error,
            install_local_core,
            enable_core_behind_proxy,
            local_core_installed,
            local_core_base_url,
            local_sidecar_ports,
            start_local_core,
            read_launch_prefill,
            // Client files (settings / cores / snippets) + keychain
            read_client_file,
            write_client_file,
            read_client_snippets,
            write_client_snippet,
            delete_client_snippet,
            keychain_set_token,
            keychain_get_token,
            keychain_delete_token,
            // Pinned core networking
            net_fetch,
            net_ws_open,
            net_ws_send,
            net_ws_close,
            discover_lan_cores,
            // Logging
            client_log,
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
                    // Stop a local core THIS session spawned (service-less mode),
                    // so quitting the client also stops the core it started. A
                    // background-service core was never recorded here, so it is
                    // left running. Only fires on true quit (tray Exit); the
                    // window close button hides to tray and never reaches Exit.
                    stop_spawned_core(state.0.spawned_core_pid.load(Ordering::SeqCst));
                }
            }
        });
}

/// Mobile shell: a single fullscreen activity. No tray, global shortcut,
/// capture, volume, autostart, or local-core install, so it registers only the
/// cross-platform command set and the plugins that have Android support.
#[cfg(mobile)]
#[allow(clippy::expect_used)]
fn run_mobile() {
    tauri::Builder::default()
        .manage(new_app_state())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Logging needs the app-data dir (no $HOME on android), so it is
            // initialized here once an AppHandle exists. Logs land under the same
            // client root that get_client_storage / truncate_client_log enumerate.
            let log_dir = crate::commands::paths::client_root(app.handle())
                .ok()
                .map(|root| root.join("logs"));
            crate::logging::init_with_log_dir(log_dir);
            log::info!(target: "tomat::boot", "tomat Client starting (channel={})", crate::channel::channel());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Pinned core networking
            net_fetch,
            net_ws_open,
            net_ws_send,
            net_ws_close,
            // Client files (settings / cores / snippets) + keychain
            read_client_file,
            write_client_file,
            read_client_snippets,
            write_client_snippet,
            delete_client_snippet,
            keychain_set_token,
            keychain_get_token,
            keychain_delete_token,
            // System (cross-platform subset)
            get_self_metrics,
            get_client_storage,
            truncate_client_log,
            resolve_path,
            client_channel,
            can_self_install,
            // Logging
            client_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
