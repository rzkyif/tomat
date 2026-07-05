// Slimmed app state: the client no longer supervises sidecars or runs a
// download queue (those are owned by tomat-core). Only Tauri-specific state
// remains: window visibility, current global shortcut, input shortcuts,
// system-volume restore marker, region-capture target.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32};
use std::sync::{Arc, Mutex};

/// Push-to-talk config + in-flight press state for the window toggle shortcut.
///
/// The tap-vs-hold decision is made HERE in Rust, not in the webview, because
/// the OS "released" signal reaches JS over the WebView2 IPC pipe on the webview
/// UI thread, which stalls exactly while the cursor is over the (interactive,
/// non-clickthrough) window - so a quick tap's release could land after the JS
/// hold timer had already fired and (wrongly) started STT. Rust learns of the
/// press/release promptly and off that thread, so it classifies correctly and
/// emits a single semantic event (`shortcut-tap` / `shortcut-hold-start` /
/// `shortcut-hold-end`) the UI just reacts to.
pub struct PttState {
    /// Whether the window shortcut is in push-to-talk mode (pushed from JS via
    /// `set_ptt_config`). When false, a press is a plain window toggle and no
    /// tap/hold classification runs.
    pub push_to_talk: bool,
    /// Hold threshold in ms: release before this is a tap, at/after it is a hold.
    pub hold_ms: u64,
    /// Bumped on every press and every release so a stale hold timer spawned by
    /// an earlier press can't fire against a newer (or already-classified) one.
    pub generation: u64,
    /// Whether the shortcut is currently physically held.
    pub down: bool,
    /// Whether the hold timer already fired for the current press (so the
    /// release knows to emit `shortcut-hold-end` rather than `shortcut-tap`).
    pub hold_started: bool,
}

impl Default for PttState {
    fn default() -> Self {
        Self {
            push_to_talk: false,
            hold_ms: 250,
            generation: 0,
            down: false,
            hold_started: false,
        }
    }
}

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
    /// Push-to-talk config + in-flight press state for the window toggle
    /// shortcut. See [`PttState`].
    pub ptt: Mutex<PttState>,
    /// The xcap monitor id the next region-capture invocation should crop
    /// against. Set by the JS helper before showing the overlay window;
    /// read by the overlay page on mount. Defaults to "primary".
    pub region_capture_target: Mutex<String>,
    /// Guard for the `install_local_core` Tauri command. Set to `true` for
    /// the duration of a running installer subprocess so a UI double-click
    /// can't kick off a second concurrent install (which would race for
    /// the same `~/.tomat/core/bin/` paths). Reset to `false` in the
    /// command's drop guard regardless of success or failure.
    pub install_in_progress: AtomicBool,
    /// Unix-ms timestamp at which the last successful `install_local_core`
    /// finished. Read by the command to enforce a short cooldown so a
    /// user spamming the "install" button doesn't re-run the installer
    /// back-to-back. Initialized to `0` (no install yet → no cooldown).
    pub install_last_finished_ms: AtomicI64,
    /// PID of a local core THIS client session spawned via `start_local_core`
    /// (the service-less "on-demand" mode). `0` means we never spawned one
    /// (either a background service owns the core, or it was already up when we
    /// probed). Only set on a real spawn, so a non-zero value means "we own this
    /// core's liveness"; on app exit we stop exactly that PID, so quitting the
    /// client also stops a core it started. Never stops a core we didn't launch.
    pub spawned_core_pid: AtomicU32,
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppStateInner>);

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn fresh() -> AppStateInner {
        AppStateInner {
            visible: AtomicBool::new(true),
            current_shortcut: Mutex::new(None),
            saved_volume: Mutex::new(None),
            input_shortcuts: Mutex::new(Vec::new()),
            ptt: Mutex::new(PttState::default()),
            region_capture_target: Mutex::new("primary".to_string()),
            install_in_progress: AtomicBool::new(false),
            install_last_finished_ms: AtomicI64::new(0),
            spawned_core_pid: AtomicU32::new(0),
        }
    }

    #[test]
    fn visible_atomic_round_trips() {
        let s = fresh();
        assert!(s.visible.load(Ordering::SeqCst));
        s.visible.store(false, Ordering::SeqCst);
        assert!(!s.visible.load(Ordering::SeqCst));
    }

    #[test]
    fn current_shortcut_mutex_swaps_value() {
        let s = fresh();
        assert!(s.current_shortcut.lock().unwrap().is_none());
        *s.current_shortcut.lock().unwrap() = Some("Cmd+Space".to_string());
        assert_eq!(
            s.current_shortcut.lock().unwrap().as_deref(),
            Some("Cmd+Space")
        );
    }

    #[test]
    fn saved_volume_is_optional_and_settable() {
        let s = fresh();
        assert!(s.saved_volume.lock().unwrap().is_none());
        *s.saved_volume.lock().unwrap() = Some(75);
        assert_eq!(*s.saved_volume.lock().unwrap(), Some(75));
        *s.saved_volume.lock().unwrap() = None;
        assert!(s.saved_volume.lock().unwrap().is_none());
    }

    #[test]
    fn input_shortcuts_starts_empty_and_appends() {
        let s = fresh();
        assert!(s.input_shortcuts.lock().unwrap().is_empty());
        s.input_shortcuts
            .lock()
            .unwrap()
            .push(("submit".into(), "Enter".into()));
        assert_eq!(s.input_shortcuts.lock().unwrap().len(), 1);
    }

    #[test]
    fn region_capture_target_defaults_primary() {
        let s = fresh();
        assert_eq!(*s.region_capture_target.lock().unwrap(), "primary");
    }
}
