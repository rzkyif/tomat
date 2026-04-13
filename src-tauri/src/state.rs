use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri_plugin_shell::process::CommandChild;

pub struct Sidecar {
    pub child: Option<CommandChild>,
    pub start_id: u64,
    pub pid: Option<u32>,
}

pub struct AppStateInner {
    pub sidecars: Mutex<HashMap<String, Sidecar>>,
    // Cap concurrent model downloads. A semaphore (vs. a mutex) lets multiple
    // model fetches proceed in parallel without overwhelming the network or
    // disk; 2 is conservative.
    pub download_sem: tokio::sync::Semaphore,
    // RwLock so concurrent metric reads don't serialize on each other; writes
    // (refresh_process) still take the write lock briefly.
    pub metrics: tokio::sync::RwLock<sysinfo::System>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppStateInner>);
