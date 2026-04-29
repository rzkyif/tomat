use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri_plugin_shell::process::CommandChild;

/// Cap on concurrent model downloads. A semaphore (vs. a mutex) lets multiple
/// model fetches proceed in parallel without overwhelming the network or
/// disk; `2` is conservative and matches typical residential-link throughput
/// for the ~1–4 GB Hugging Face files we pull.
pub const MAX_CONCURRENT_DOWNLOADS: usize = 2;

pub struct Sidecar {
    pub child: Option<CommandChild>,
    pub start_id: u64,
    pub pid: Option<u32>,
}

pub struct AppStateInner {
    pub sidecars: Mutex<HashMap<String, Sidecar>>,
    pub download_sem: tokio::sync::Semaphore,
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
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppStateInner>);
