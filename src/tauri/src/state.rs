use crate::download::DownloadManager;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri_plugin_shell::process::CommandChild;

/// Cap on concurrent model downloads. Held at `1` so we don't trip
/// HuggingFace's per-IP burst limits when several files are queued back to
/// back; the manager additionally inserts a `INTER_DOWNLOAD_DELAY` pause
/// between consecutive transfers for the same reason.
pub const MAX_CONCURRENT_DOWNLOADS: usize = 1;

pub struct Sidecar {
    pub child: Option<CommandChild>,
    pub start_id: u64,
    pub pid: Option<u32>,
}

pub struct AppStateInner {
    pub sidecars: Mutex<HashMap<String, Sidecar>>,
    /// Centralized download queue. Constructed at app startup with the
    /// persisted state from `~/.tomat/downloads.json`; resumed Pending items
    /// are spawned in setup() once the `AppHandle` is available.
    pub downloads: Arc<DownloadManager>,
    // RwLock so concurrent metric reads don't serialize on each other; writes
    // (refresh_process) still take the write lock briefly.
    pub metrics: tokio::sync::RwLock<sysinfo::System>,
    // Currently registered global toggle-window shortcut, so we can unregister
    // it before applying a new one. `None` when the user has disabled it.
    pub current_shortcut: Mutex<Option<String>>,
    // Tracked main-window visibility. Single source of truth shared across the
    // tray icon, the global shortcut, the close-to-tray handler, and the
    // show/hide commands so they can't drift out of sync.
    pub visible: AtomicBool,
    // System output volume captured the first time we lower it for STT auto-
    // volume during a listening session. `Some(v)` means a restore is owed;
    // `None` means we haven't lowered (or have already restored). Shared so
    // the JS-side commands and the graceful-shutdown handler agree on whether
    // a restore is needed.
    pub saved_volume: Mutex<Option<u8>>,
    // Currently registered input shortcuts (event name + accelerator). Cleared
    // on UserInput unmount. Tracked so we can unregister cleanly before
    // re-registering with new bindings.
    pub input_shortcuts: Mutex<Vec<(String, String)>>,
    // The xcap monitor id the next region-capture invocation should crop
    // against. Set by the JS helper before showing the overlay window;
    // read by the overlay page on mount. Defaults to "primary".
    pub region_capture_target: Mutex<String>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppStateInner>);
