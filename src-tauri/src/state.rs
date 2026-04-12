use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri_plugin_shell::process::CommandChild;

pub struct Sidecar {
    pub child: Option<CommandChild>,
    pub start_id: u64,
}

pub struct AppStateInner {
    pub sidecars: Mutex<HashMap<String, Sidecar>>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppStateInner>);
