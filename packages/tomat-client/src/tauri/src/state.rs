// Slimmed app state: the client no longer supervises sidecars or runs a
// download queue (those are owned by tomat-core). Only Tauri-specific state
// remains: window visibility, current global shortcut, input shortcuts,
// system-volume restore marker, region-capture target.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

pub struct AppStateInner {
    /// Tracked main-window visibility. Single source of truth shared across
    /// the tray icon, the global shortcut, the close-to-tray handler, and
    /// the show/hide commands so they can't drift out of sync.
    pub visible: AtomicBool,
    /// Currently registered global toggle-window shortcut, so we can
    /// unregister it before applying a new one. `None` when disabled.
    pub current_shortcut: Mutex<Option<String>>,
    /// System output volume captured the first time we lower it for STT
    /// auto-volume during a listening session. `Some(v)` means a restore
    /// is owed; `None` means we haven't lowered (or have already restored).
    pub saved_volume: Mutex<Option<u8>>,
    /// Currently registered input shortcuts (event name + accelerator).
    /// Cleared on UserInput unmount.
    pub input_shortcuts: Mutex<Vec<(String, String)>>,
    /// The xcap monitor id the next region-capture invocation should crop
    /// against. Set by the JS helper before showing the overlay window;
    /// read by the overlay page on mount. Defaults to "primary".
    pub region_capture_target: Mutex<String>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppStateInner>);
