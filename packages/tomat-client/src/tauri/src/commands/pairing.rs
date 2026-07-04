// Pairing-flow commands.
//
//  - `read_admin_token`: read ~/.tomat/<channel>/core/.admin-token off disk
//    so the client can mint pairing codes on the LOCAL core. Returns None if
//    the file doesn't exist (e.g. paired with a remote core).
//
//  - `install_local_core`: shells out to the R2-hosted install script for
//    the host platform, captures stdout, parses the printed pairing code,
//    and returns it. While the script runs, its transcript rows are tailed
//    and re-emitted as `core-install-progress` events so the UI's install
//    button can narrate the phases. The (now thin) script fetches + verifies
//    the seed core binary, then delegates the rest to that binary's own
//    install subcommands (`self-install`, `install-service`, `mint-code` -
//    see packages/tomat-core/src/install), which set up the service, mint the
//    admin token, plant the built-in extension, and print the pairing code.
//    This command is just the trampoline and still parses `Pairing code:`.
//
//  - `start_local_core`: idempotently make sure a locally-installed core
//    is running. Used at app boot for the "on-demand" install mode where
//    no system service was registered (the client owns liveness).

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

const DEFAULT_STORAGE_BASE: &str = "https://get.au.tomat.ing";

/// True when this is the dev-channel build. The dev core runs from source via
/// `deno task dev`, so there's no installed binary and nothing to `curl`.
fn is_dev() -> bool {
    crate::channel::channel() == "dev"
}

/// True when the developer opted into exercising the fresh-install confirm
/// screen in dev (`deno task dev:reset:install` sets TOMAT_DEV_FRESH_INSTALL).
/// Always false outside dev.
fn dev_fresh_install_requested() -> bool {
    is_dev()
        && std::env::var("TOMAT_DEV_FRESH_INSTALL")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

#[tauri::command]
pub fn read_admin_token() -> AppResult<Option<String>> {
    read_admin_token_at(&admin_token_path()?)
}

fn read_admin_token_at(path: &std::path::Path) -> AppResult<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppError::Io(err)),
    }
}

/// Cooldown enforced AFTER a successful install completes. Pairs with the
/// in-progress guard: the guard rejects parallel runs; this rejects rapid
/// re-runs in the brief window where the supervisor / launchd / scheduled
/// task is still starting the freshly-installed core. 10 s is enough for
/// the on-demand spawn path to observe the new binary on the next
/// `start_local_core` poll.
const INSTALL_COOLDOWN_MS: i64 = 10_000;

/// Event name the install progress snapshots are emitted under; the UI's
/// pairing.subscribeInstallProgress listens for it.
pub const INSTALL_PROGRESS_EVENT: &str = "core-install-progress";

#[tauri::command]
pub async fn install_local_core(
    app: AppHandle,
    state: State<'_, AppState>,
    service: Option<bool>,
    bind_all: Option<bool>,
) -> AppResult<String> {
    // Dev: no installer artifact and the core already runs from source, so
    // "installing" just mints a code off the running dev core, enough to drive
    // the fresh-install UI end to end. The service/bindAll toggles are cosmetic
    // here.
    if is_dev() {
        return dev_mint_pairing_code().await;
    }

    // Cooldown check: if a previous install finished less than
    // INSTALL_COOLDOWN_MS ago, reject. Reading the last-finished timestamp
    // is cheap (single atomic load) so we do it before the in-progress CAS.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let last_finished = state.0.install_last_finished_ms.load(Ordering::SeqCst);
    let cooldown_remaining = INSTALL_COOLDOWN_MS - (now_ms - last_finished);
    if last_finished > 0 && cooldown_remaining > 0 {
        return Err(AppError::external(format!(
            "install cooldown active; retry in {} ms",
            cooldown_remaining
        )));
    }

    // Reject concurrent installer kicks: two parallel installer scripts
    // would race for the same ~/.tomat/core/bin/ paths, leaving the
    // install in an undefined state. The UI typically guards on a button
    // disabled state, but defense-in-depth: a double-click or repeated
    // shortcut press should fail-fast on the second invocation.
    if state
        .0
        .install_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::external(
            "install already running; wait for the previous run to finish",
        ));
    }
    // Clone the Arc so the drop guard can clear the flag and stamp the
    // cooldown even if the function returns early via `?`. The flag is on
    // the long-lived AppStateInner; AppState is itself an Arc, so the
    // clone is cheap.
    let state_for_guard = state.0.clone();
    let _guard = InstallGuard {
        state: state_for_guard,
    };

    let url = installer_url();
    // Default to background service if unspecified; older callers still work.
    let install_service = service.unwrap_or(true);
    let install_bind_all = bind_all.unwrap_or(false);
    let output = tokio::task::spawn_blocking(move || {
        run_installer(&url, install_service, install_bind_all, |progress| {
            let _ = app.emit(INSTALL_PROGRESS_EVENT, &progress);
        })
    })
    .await
    .map_err(|e| AppError::external(format!("installer task panicked: {e}")))??;
    parse_pairing_code(&output)
}

/// Switch the locally-installed, already-paired core into "served behind an
/// HTTPS proxy" mode: run the installed binary's `enable-behind-proxy` verb,
/// which merges `server.behindProxy=true` into settings.json and restarts the
/// core so it takes effect. Called by the client's "install, pair, then flip"
/// flow AFTER the loopback pair, because a proxy-served core folds no cert pin
/// and so can't be paired over loopback. The pin captured at pairing is
/// unaffected (same key, same self-signed cert served on loopback), so this
/// client keeps connecting; later remote devices reach the core through the
/// proxy and pair by validating the proxy's certificate instead.
///
/// `service` mirrors the install's "keep running in the background" choice so
/// the restart uses the matching path. Output is captured to temp files, never
/// pipes: the verb relaunches a detached core, which on Windows would inherit a
/// piped handle and block a reader forever (see run_installer_capturing).
#[tauri::command]
pub async fn enable_core_behind_proxy(service: bool) -> AppResult<()> {
    // Dev core runs from source with no installed binary and no real install to
    // reconfigure; nothing to flip.
    if is_dev() {
        return Ok(());
    }
    let bin = local_core_binary()?;
    if !bin.exists() {
        return Err(AppError::external(format!(
            "local core not installed at {}",
            bin.display(),
        )));
    }
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(&bin);
        cmd.arg("enable-behind-proxy")
            .env("TOMAT_CHANNEL", crate::channel::channel())
            .env("TOMAT_INSTALL_SERVICE", if service { "1" } else { "0" });
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        run_subcommand_capturing(cmd, "enable-behind-proxy")
    })
    .await
    .map_err(|e| AppError::external(format!("enable-behind-proxy task panicked: {e}")))?
}

/// Run a short-lived core install subcommand with stdout/stderr captured to temp
/// FILES (never pipes) and wait for it. The subcommand may relaunch a detached
/// core, which on Windows inherits handles and would block a piped reader
/// forever (see run_installer_capturing for the full rationale); a file handle
/// is harmless to inherit. Returns the trimmed stderr in the error on failure.
fn run_subcommand_capturing(mut cmd: Command, what: &str) -> AppResult<()> {
    use std::io::Read;
    let out = tempfile::NamedTempFile::new()?;
    let err = tempfile::NamedTempFile::new()?;
    let status = cmd.stdout(out.reopen()?).stderr(err.reopen()?).status()?;
    if status.success() {
        return Ok(());
    }
    let mut buf = Vec::new();
    if let Ok(mut f) = std::fs::File::open(err.path()) {
        let _ = f.read_to_end(&mut buf);
    }
    Err(AppError::external(format!(
        "{} exited with status {}: {}",
        what,
        status,
        String::from_utf8_lossy(&buf).trim()
    )))
}

struct InstallGuard {
    state: std::sync::Arc<crate::state::AppStateInner>,
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        // Stamp the cooldown clock BEFORE releasing the in-progress flag so
        // a thread spinning on the CAS observes the cooldown immediately on
        // success. Both stores use SeqCst for the same reason.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.state
            .install_last_finished_ms
            .store(now_ms, Ordering::SeqCst);
        self.state
            .install_in_progress
            .store(false, Ordering::SeqCst);
    }
}

fn installer_url() -> String {
    let base = std::env::var("TOMAT_STORAGE").unwrap_or_else(|_| DEFAULT_STORAGE_BASE.into());
    installer_url_from_base(&base)
}

/// Pure URL builder. `installer_url` wraps this with the `TOMAT_STORAGE`
/// lookup; keeping the formatting separate lets tests assert on it without
/// mutating process-global env (which races under parallel test threads).
fn installer_url_from_base(base: &str) -> String {
    let suffix = if cfg!(windows) { "core.ps1" } else { "core.sh" };
    format!("{}/install/{}", base, suffix)
}

fn install_service_flag(service: bool) -> &'static str {
    if service {
        "1"
    } else {
        "0"
    }
}

#[cfg(unix)]
fn run_installer(
    url: &str,
    service: bool,
    bind_all: bool,
    on_progress: impl FnMut(InstallProgress),
) -> AppResult<String> {
    let pipeline = format!("curl -fsSL '{}' | bash", url);
    let mut cmd = Command::new("bash");
    cmd.arg("-c")
        .arg(&pipeline)
        // Install into THIS client's channel so a latest client installs a latest
        // core (not stable). The installer bakes it into the service env.
        .env("TOMAT_CHANNEL", crate::channel::channel())
        .env("TOMAT_INSTALL_SERVICE", install_service_flag(service))
        .env("TOMAT_INSTALL_BIND_ALL", install_service_flag(bind_all));
    run_installer_capturing(cmd, on_progress)
}

#[cfg(windows)]
fn run_installer(
    url: &str,
    service: bool,
    bind_all: bool,
    on_progress: impl FnMut(InstallProgress),
) -> AppResult<String> {
    use std::os::windows::process::CommandExt;
    // A GUI-subsystem app spawning a console app (powershell.exe) makes Windows
    // pop up a console window whose stdout we've redirected into the pipe below,
    // so it renders empty (only IWR's progress bar draws to the host). Suppress
    // it: the install runs silently and the client's own UI is the sole feedback,
    // matching the windowless macOS/Linux path. 0x08000000 = CREATE_NO_WINDOW.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let ps = format!("iwr -useb '{}' | iex", url);
    let mut cmd = Command::new("powershell");
    cmd.args(["-ExecutionPolicy", "Bypass", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        // Install into THIS client's channel so a latest client installs a latest
        // core (not stable). The installer bakes it into the service env.
        .env("TOMAT_CHANNEL", crate::channel::channel())
        .env("TOMAT_INSTALL_SERVICE", install_service_flag(service))
        .env("TOMAT_INSTALL_BIND_ALL", install_service_flag(bind_all));
    run_installer_capturing(cmd, on_progress)
}

/// One step of the running install, parsed from the installer transcript and
/// emitted to the UI so the install button can narrate what is happening.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// The active phase's label, e.g. "Downloading the Core".
    pub label: String,
    /// Phases finished so far.
    pub done: u32,
    /// Total phases the installer registered.
    pub total: u32,
}

/// Incremental parser over the install scripts' non-TTY transcript. The
/// scripts register every phase up front as a `[ ] Label` pending row, flip
/// the active one to `[*] Label (suffix)`, and settle rows as `[✓]`/`[~]`/`[x]`
/// lines, so the transcript itself is the progress protocol:
///   - pending rows count toward `total`,
///   - a `[*]` row is the active phase (label reported minus any `(suffix)`),
///   - any other glyph settles a row and bumps `done`.
///
/// Settled-glyph lines can arrive mangled on Windows (checkmarks crossing the
/// console codepage), so `done` is also inferred from the count of distinct
/// started labels; whichever is larger wins.
struct InstallProgressParser {
    total: u32,
    settled: u32,
    started: u32,
    last_label: String,
}

impl InstallProgressParser {
    fn new() -> Self {
        Self {
            total: 0,
            settled: 0,
            started: 0,
            last_label: String::new(),
        }
    }

    /// Feed one transcript line; returns the updated snapshot when the line is
    /// a `[*]` (active-phase) row. Non-row lines are ignored.
    fn feed(&mut self, line: &str) -> Option<InstallProgress> {
        let rest = line.trim().strip_prefix('[')?;
        let mut chars = rest.chars();
        let glyph = chars.next()?;
        let label = chars.as_str().strip_prefix("] ")?;
        match glyph {
            ' ' => {
                self.total += 1;
                None
            }
            '*' => {
                let label = strip_row_suffix(label);
                if label != self.last_label {
                    self.started += 1;
                    self.last_label = label.to_string();
                }
                Some(InstallProgress {
                    label: label.to_string(),
                    done: self.done(),
                    total: self.total.max(self.started),
                })
            }
            _ => {
                self.settled += 1;
                None
            }
        }
    }

    fn done(&self) -> u32 {
        self.settled
            .max(self.started.saturating_sub(1))
            .min(self.total)
    }
}

/// Drop a trailing `(suffix)` like "(downloading)" from a row's text: the
/// button renders the label plus a percentage, not the inline detail.
fn strip_row_suffix(text: &str) -> &str {
    let t = text.trim_end();
    if t.ends_with(')') {
        if let Some(open) = t.rfind('(') {
            return t[..open].trim_end();
        }
    }
    t
}

/// Hard cap on one installer run. Generous (the payload is a slow-connection
/// multi-hundred-MB download) but finite, so no future installer bug can ever
/// strand the UI on "Installing" again: on expiry the child is killed and the
/// command errors out.
const INSTALL_HARD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45 * 60);

/// Run the installer, capturing stdout/stderr to temp FILES, tailing the
/// stdout file for progress rows while the direct child runs, and parsing the
/// captured output once it exits.
///
/// Why not `Command::output()` (pipes): on the "don't keep running in
/// background" path the installer backgrounds the freshly-installed core, which
/// can inherit stray stdio handles (unix: the `exec 3>&1` dup in the
/// installer UI; windows: `Start-Process` forcing `bInheritHandles`). With a
/// PIPE, reading to EOF hangs forever because the detached core holds the write
/// end open - the "stuck on installing" bug. It would ALSO hang on the failure
/// path (a failure AFTER the core is backgrounded, e.g. the core not coming up
/// before the pairing step). A FILE handle is harmless to inherit (it never
/// blocks a reader), and doubles as the live progress feed: we poll it for new
/// lines while waiting on the DIRECT child, which exits promptly once it has
/// minted the code (or failed), regardless of the detached core.
/// `NamedTempFile` is mode 0600 with an unpredictable name, so the
/// briefly-on-disk pairing code isn't exposed to other users and there's no
/// symlink pre-creation race; it also lossy-decodes, so odd installer bytes
/// never abort the parse.
fn run_installer_capturing(
    mut cmd: Command,
    mut on_progress: impl FnMut(InstallProgress),
) -> AppResult<String> {
    use std::io::Read;

    let out = tempfile::NamedTempFile::new()?;
    let err = tempfile::NamedTempFile::new()?;
    let mut child = cmd.stdout(out.reopen()?).stderr(err.reopen()?).spawn()?;

    // Tail the stdout file: a fresh read handle at offset 0 that picks up
    // appended bytes on each poll. Only complete lines are parsed; a partial
    // tail line stays buffered until its newline lands.
    let mut tail = out.reopen()?;
    let mut pending: Vec<u8> = Vec::new();
    let mut parser = InstallProgressParser::new();
    let mut last_emitted: Option<InstallProgress> = None;
    let started_at = std::time::Instant::now();

    let status = loop {
        // Order matters: check exit BEFORE draining, then drain, so the final
        // lines written just before exit are still parsed on the last pass.
        let exited = child.try_wait()?;
        let mut chunk = [0u8; 8192];
        loop {
            let n = tail.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&chunk[..n]);
        }
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(p) = parser.feed(line.trim_end_matches(['\r', '\n'])) {
                // Suffix-only row updates parse to the same snapshot; emit
                // only real transitions.
                if last_emitted.as_ref() != Some(&p) {
                    last_emitted = Some(p.clone());
                    on_progress(p);
                }
            }
        }
        if let Some(status) = exited {
            break status;
        }
        if started_at.elapsed() > INSTALL_HARD_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::external(
                "the Core installer did not finish within 45 minutes and was stopped; \
                 check your connection and try again",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    };

    let read_lossy = |path: &std::path::Path| -> String {
        let mut buf = Vec::new();
        if let Ok(mut f) = std::fs::File::open(path) {
            let _ = f.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    };

    let stdout = read_lossy(out.path());
    if !status.success() {
        let stderr = read_lossy(err.path());
        return Err(AppError::external(format!(
            "installer exited with status {}: {}",
            status,
            stderr.trim()
        )));
    }
    Ok(stdout)
}

fn parse_pairing_code(output: &str) -> AppResult<String> {
    // Both install scripts print `Pairing code: NNNNNN` (with leading
    // whitespace). The last occurrence wins; re-runs print the new code.
    let code = output
        .lines()
        .rev()
        .find_map(|line| {
            line.trim()
                .strip_prefix("Pairing code:")
                .map(|c| c.trim().to_string())
        })
        .filter(|c| c.chars().all(|ch| ch.is_ascii_digit()) && c.len() == 6);
    code.ok_or_else(|| {
        AppError::external(format!(
            "installer succeeded but no 6-digit pairing code found in output. \
             Mint one manually with the printed `curl` command. Output:\n{}",
            output
        ))
    })
}

/// Dev-only: mint a pairing code straight off the running dev core (the same
/// admin-token endpoint the installer hits in production), so the fresh-install
/// flow can complete without an installer artifact. Returns the 6-digit code.
async fn dev_mint_pairing_code() -> AppResult<String> {
    let token = read_admin_token_at(&admin_token_path()?)?.ok_or_else(|| {
        AppError::external("dev core admin token not found. Is `deno task dev` running?")
    })?;
    let url = format!(
        "https://127.0.0.1:{}/api/v1/pairing/codes",
        crate::channel::core_port()
    );
    // Dev loopback against a known self-signed cert. The real pairing trust
    // (PAKE + SPKI pin) is still enforced afterwards by the TS net layer when
    // the UI claims this code.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| AppError::external(format!("http client: {e}")))?;
    let resp = client
        .post(&url)
        .header("X-Admin-Token", token)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| AppError::external(format!("mint request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::external(format!(
            "mint failed: HTTP {}",
            resp.status()
        )));
    }
    #[derive(serde::Deserialize)]
    struct CodeResp {
        code: String,
    }
    let parsed: CodeResp = resp
        .json()
        .await
        .map_err(|e| AppError::external(format!("bad mint response: {e}")))?;
    Ok(parsed.code)
}

fn admin_token_path() -> AppResult<PathBuf> {
    let home = std::env::home_dir()
        .ok_or_else(|| AppError::external("could not determine home directory"))?;
    Ok(crate::channel::channel_root(&home)
        .join("core")
        .join(".admin-token"))
}

fn boot_error_path() -> AppResult<PathBuf> {
    let home = std::env::home_dir()
        .ok_or_else(|| AppError::external("could not determine home directory"))?;
    Ok(crate::channel::channel_root(&home)
        .join("core")
        .join("last-error.txt"))
}

/// Read the local core's last fatal boot-failure reason (one line), if any. The
/// core writes it on a fatal startup path and clears it once it next binds, so
/// this is non-empty only when the local core failed to come up (port in use,
/// missing helper, ...). Lets the pair flow explain an otherwise-opaque
/// connection failure. Returns None when the file is absent or blank. Reuses the
/// admin-token reader, which is the same "trimmed non-empty string or None".
#[tauri::command]
pub fn read_local_core_boot_error() -> AppResult<Option<String>> {
    read_admin_token_at(&boot_error_path()?)
}

fn local_core_binary() -> AppResult<PathBuf> {
    let home = std::env::home_dir()
        .ok_or_else(|| AppError::external("could not determine home directory"))?;
    // Channel-suffixed: latest's core lives at .../bin/tomat-core-latest(.exe).
    Ok(crate::channel::channel_root(&home)
        .join("core")
        .join("bin")
        .join(crate::channel::core_binary_name()))
}

/// Returns `true` if the local core binary exists on disk.
#[tauri::command]
pub fn local_core_installed() -> AppResult<bool> {
    // Dev runs the core from source (no installed binary), but a dev core IS
    // running via `deno task dev`. Report it as installed so "On this computer"
    // takes the already-installed fast path, unless the developer opted into
    // the fresh-install flow, where `false` makes the confirm screen show and
    // the install is then simulated against the running dev core.
    if is_dev() {
        return Ok(!dev_fresh_install_requested());
    }
    Ok(local_core_binary().map(|p| p.exists()).unwrap_or(false))
}

/// Loopback base URL of THIS channel's local core, with the channel-aware port
/// (stable 7800, latest 7810, …). The UI uses it for the "on this computer"
/// install/pair flow so a latest client targets the latest core.
#[tauri::command]
pub fn local_core_base_url() -> String {
    format!("https://127.0.0.1:{}", crate::channel::core_port())
}

/// This channel's default local sidecar ports (llama / speech). The UI uses
/// them as fallbacks when the paired core hasn't overridden llm.port/stt.port,
/// so a latest client talks to the latest sidecars (7711/7712), not stable's.
#[tauri::command]
pub fn local_sidecar_ports() -> std::collections::HashMap<String, u16> {
    let mut m = std::collections::HashMap::new();
    m.insert("llm".to_string(), crate::channel::llm_port());
    m.insert("stt".to_string(), crate::channel::stt_port());
    m
}

/// Spawn the locally-installed core detached when it isn't already running.
/// Called from app boot for the "on-demand" install mode. Idempotent: if the
/// admin endpoint already answers, this is a no-op and returns `false`.
/// Returns `true` if a new process was started.
#[tauri::command]
pub async fn start_local_core(state: State<'_, AppState>) -> AppResult<bool> {
    // Dev: the core is started from source by `deno task dev`, not a binary we
    // can spawn here. Confirm it's reachable; never try to launch it.
    if is_dev() {
        return if probe_local_core().await {
            Ok(false)
        } else {
            Err(AppError::external(
                "dev core not reachable on 127.0.0.1:7820. Is `deno task dev` running?",
            ))
        };
    }

    let bin = local_core_binary()?;
    if !bin.exists() {
        return Err(AppError::external(format!(
            "local core not installed at {}",
            bin.display(),
        )));
    }

    // Cheap liveness probe: if 127.0.0.1:7800 is already answering, leave it.
    if probe_local_core().await {
        return Ok(false);
    }

    let logs_dir = bin
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("logs"))
        .ok_or_else(|| AppError::external("could not derive logs dir"))?;
    std::fs::create_dir_all(&logs_dir)?;

    let pid = spawn_detached(&bin, &logs_dir)?;
    // Record that WE started this core so app-exit stops exactly it (service-less
    // "on-demand" mode). We only reach here when the probe found nothing running,
    // so a background-service core is never recorded and never stopped on exit.
    state.0.spawned_core_pid.store(pid, Ordering::SeqCst);

    // Best-effort wait for the port to come up so the next pairing /
    // settings call doesn't race with the spawn.
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if probe_local_core().await {
            return Ok(true);
        }
    }
    // It might still be coming up, so return success rather than block the UI.
    Ok(true)
}

/// Minimal liveness probe of the local core: a plain TCP connect to the core
/// port. The core now serves TLS, so we can't speak HTTP/1.0 in the clear here;
/// a successful connect means the listener is up. The real health check happens
/// over the pinned TLS net layer once paired. Raw TcpStream avoids pulling a
/// TLS client into this one cheap probe.
async fn probe_local_core() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    let task = tokio::task::spawn_blocking(|| -> bool {
        let Ok(addr) = format!("127.0.0.1:{}", crate::channel::core_port()).parse() else {
            return false;
        };
        TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok()
    });
    task.await.unwrap_or(false)
}

/// Spawn the core detached and return its PID so the caller can record which
/// core THIS session started (and stop exactly it on app exit).
#[cfg(unix)]
fn spawn_detached(bin: &std::path::Path, logs_dir: &std::path::Path) -> AppResult<u32> {
    use std::fs::OpenOptions;
    use std::os::unix::process::CommandExt;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("core.stdout.log"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("core.stderr.log"))?;
    // setsid so the child survives the client exiting.
    let child = unsafe {
        Command::new(bin)
            .stdout(stdout)
            .stderr(stderr)
            // The compiled-in channel isn't an OS env var, so the spawned core
            // wouldn't otherwise know it. Pass it explicitly so the on-demand
            // core matches this client's channel.
            .env("TOMAT_CHANNEL", crate::channel::channel())
            .pre_exec(|| {
                if libc_setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            })
            .spawn()?
    };
    Ok(child.id())
}

#[cfg(unix)]
fn libc_setsid() -> i32 {
    // Bind to libc dynamically to avoid adding a libc dep just for this.
    unsafe extern "C" {
        fn setsid() -> i32;
    }
    unsafe { setsid() }
}

/// Stop a core THIS session spawned (service-less mode). Called from the app's
/// exit handler so quitting the client also stops a core it started. Best-effort
/// and non-blocking: `pid == 0` (we never spawned one, e.g. a background service
/// owns the core) is a no-op. Unix sends SIGTERM so the core runs its graceful
/// shutdown (sidecar/MCP teardown). Windows hard-kills the tree; the in-core Job
/// Object still reaps sidecars when the core dies, so nothing is orphaned.
pub fn stop_spawned_core(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        // Guard against PID reuse: a mid-session core crash could free this PID
        // for an unrelated process, and we must not signal that. Only proceed if
        // the PID still looks like our core. "tomat-core" survives Linux's
        // 15-char `comm` truncation and appears in macOS's full-path `comm`.
        let looks_like_core = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("tomat-core"))
            .unwrap_or(false);
        if !looks_like_core {
            return;
        }
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        const SIGTERM: i32 = 15;
        unsafe {
            kill(pid as i32, SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // The IMAGENAME filter is the PID-reuse guard: taskkill matches nothing
        // (a no-op) unless the PID is still a tomat-core process, so a recycled
        // PID belonging to something else is never killed.
        let image = crate::channel::core_binary_name();
        let _ = Command::new("taskkill")
            .args([
                "/F",
                "/T",
                "/FI",
                &format!("PID eq {pid}"),
                "/FI",
                &format!("IMAGENAME eq {image}"),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

/// Spawn the core detached and return its PID (see the unix variant).
#[cfg(windows)]
fn spawn_detached(bin: &std::path::Path, logs_dir: &std::path::Path) -> AppResult<u32> {
    use std::fs::OpenOptions;
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW (not DETACHED_PROCESS): the core gets a console that is
    // never shown, instead of no console at all. Console-subsystem sidecars the
    // core later spawns (llama-server, tomat-core-speech) inherit this hidden
    // console rather than allocating their own VISIBLE one, which is what popped
    // terminal windows on Windows. The core still survives the client exiting
    // (Windows doesn't reap children on parent exit). CREATE_NEW_PROCESS_GROUP
    // keeps it out of our Ctrl+C group.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("core.stdout.log"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("core.stderr.log"))?;
    let child = Command::new(bin)
        .stdout(stdout)
        .stderr(stderr)
        // Pass this client's channel so the on-demand core matches it (the
        // compiled-in channel isn't visible to the spawned process otherwise).
        .env("TOMAT_CHANNEL", crate::channel::channel())
        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
        .spawn()?;
    Ok(child.id())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPrefill {
    core_url: Option<String>,
    pairing_code: Option<String>,
}

/// Read optional `--core-url` / `--pairing-code` launch arguments (both
/// `--flag value` and `--flag=value` accepted) for the onboarding "On another
/// computer" prefill. `None` when neither is present. Doubles as a shareable
/// setup command, and is how `deno task dev` hands the dev core URL + minted
/// code to the client.
#[tauri::command]
pub fn read_launch_prefill() -> Option<LaunchPrefill> {
    let args: Vec<String> = std::env::args().collect();
    let core_url = arg_value(&args, "--core-url");
    let pairing_code = arg_value(&args, "--pairing-code");
    if core_url.is_none() && pairing_code.is_none() {
        return None;
    }
    Some(LaunchPrefill {
        core_url,
        pairing_code,
    })
}

/// Find `--name=value` or `--name value` in `args`; `None` if absent.
fn arg_value(args: &[String], name: &str) -> Option<String> {
    let eq_prefix = format!("{name}=");
    for (i, a) in args.iter().enumerate() {
        if let Some(v) = a.strip_prefix(&eq_prefix) {
            return Some(v.to_string());
        }
        if a == name {
            return args.get(i + 1).cloned();
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn installer_url_uses_default_storage_base() {
        let url = installer_url_from_base(DEFAULT_STORAGE_BASE);
        assert!(url.starts_with(DEFAULT_STORAGE_BASE));
        assert!(url.ends_with("core.sh") || url.ends_with("core.ps1"));
    }

    #[test]
    fn installer_url_honors_storage_override() {
        let url = installer_url_from_base("https://test.example");
        assert!(url.starts_with("https://test.example/install/"));
    }

    /// Feed a transcript through the parser, returning every emitted snapshot
    /// (with the caller-side dedupe the real loop applies).
    fn feed_all(lines: &[&str]) -> Vec<InstallProgress> {
        let mut parser = InstallProgressParser::new();
        let mut out: Vec<InstallProgress> = Vec::new();
        for line in lines {
            if let Some(p) = parser.feed(line) {
                if out.last() != Some(&p) {
                    out.push(p);
                }
            }
        }
        out
    }

    #[test]
    fn progress_parser_tracks_phases_and_totals() {
        let events = feed_all(&[
            "",
            "  tomat Core installer",
            "  [ ] Checking this computer",
            "  [ ] Finding the newest Core",
            "  [ ] Downloading the Core",
            "  [*] Checking this computer",
            "  [\u{2713}] Checking this computer (x86_64-pc-windows-msvc)",
            "  [*] Finding the newest Core",
            "  [\u{2713}] Finding the newest Core (v0.1.8)",
            "  [*] Downloading the Core (downloading)",
            "  [*] Downloading the Core (verifying)",
        ]);
        assert_eq!(
            events,
            vec![
                InstallProgress {
                    label: "Checking this computer".into(),
                    done: 0,
                    total: 3
                },
                InstallProgress {
                    label: "Finding the newest Core".into(),
                    done: 1,
                    total: 3
                },
                InstallProgress {
                    label: "Downloading the Core".into(),
                    done: 2,
                    total: 3
                },
            ]
        );
    }

    #[test]
    fn progress_parser_counts_skipped_rows_as_done() {
        let events = feed_all(&[
            "  [ ] Downloading the Core",
            "  [ ] Installing helpers and workers",
            "  [~] Downloading the Core (already current)",
            "  [*] Installing helpers and workers",
        ]);
        assert_eq!(
            events,
            vec![InstallProgress {
                label: "Installing helpers and workers".into(),
                done: 1,
                total: 2
            }]
        );
    }

    #[test]
    fn progress_parser_infers_done_from_starts_when_glyphs_mangle() {
        // Windows PowerShell can garble the settled checkmark glyph across the
        // console codepage; a `[?]`-ish line still counts, and even a line the
        // row-parse rejects entirely is covered by the started-labels fallback.
        let events = feed_all(&[
            "  [ ] Checking this computer",
            "  [ ] Finding the newest Core",
            "  [*] Checking this computer",
            "  [\u{fffd}\u{fffd}] Checking this computer", // glyph mangled to 2 chars: unparseable row
            "  [*] Finding the newest Core",
        ]);
        assert_eq!(
            events,
            vec![
                InstallProgress {
                    label: "Checking this computer".into(),
                    done: 0,
                    total: 2
                },
                InstallProgress {
                    label: "Finding the newest Core".into(),
                    done: 1,
                    total: 2
                },
            ]
        );
    }

    #[test]
    fn progress_parser_ignores_footer_and_stray_lines() {
        let mut parser = InstallProgressParser::new();
        assert_eq!(parser.feed("  Pairing code: 123456"), None);
        assert_eq!(
            parser.feed("  Open a tomat Client, choose to pair..."),
            None
        );
        assert_eq!(parser.feed("no brackets here"), None);
    }

    #[test]
    fn strip_row_suffix_drops_trailing_parenthetical_only() {
        assert_eq!(
            strip_row_suffix("Downloading the Core (verifying)"),
            "Downloading the Core"
        );
        assert_eq!(
            strip_row_suffix("Downloading the Core"),
            "Downloading the Core"
        );
        assert_eq!(
            strip_row_suffix("Getting a pairing code (waiting for core)"),
            "Getting a pairing code"
        );
    }

    #[test]
    fn parse_pairing_code_picks_last_occurrence() {
        let out = "Pairing code: 111111\nsome noise\nPairing code: 222222\n";
        assert_eq!(parse_pairing_code(out).unwrap(), "222222");
    }

    #[test]
    fn parse_pairing_code_strips_surrounding_whitespace_and_indent() {
        let out = "   Pairing code:   654321   \n";
        assert_eq!(parse_pairing_code(out).unwrap(), "654321");
    }

    #[test]
    fn parse_pairing_code_rejects_non_six_digit() {
        assert!(parse_pairing_code("Pairing code: 12345\n").is_err());
        assert!(parse_pairing_code("Pairing code: 1234567\n").is_err());
        assert!(parse_pairing_code("Pairing code: 12a456\n").is_err());
    }

    #[test]
    fn parse_pairing_code_fails_when_label_missing() {
        let err = parse_pairing_code("nothing useful here\n").unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("no 6-digit pairing code"));
    }

    #[test]
    fn read_admin_token_missing_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no-such-file");
        assert_eq!(read_admin_token_at(&path).unwrap(), None);
    }

    #[test]
    fn read_admin_token_empty_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty");
        std::fs::write(&path, "   \n").unwrap();
        assert_eq!(read_admin_token_at(&path).unwrap(), None);
    }

    #[test]
    fn read_admin_token_trims_whitespace_and_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tok");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "  abc123  ").unwrap();
        assert_eq!(
            read_admin_token_at(&path).unwrap(),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn arg_value_reads_equals_form() {
        let args = vec!["app".into(), "--core-url=https://x:7820".into()];
        assert_eq!(
            arg_value(&args, "--core-url").as_deref(),
            Some("https://x:7820")
        );
    }

    #[test]
    fn arg_value_reads_space_form() {
        let args = vec!["app".into(), "--pairing-code".into(), "123456".into()];
        assert_eq!(
            arg_value(&args, "--pairing-code").as_deref(),
            Some("123456")
        );
    }

    #[test]
    fn arg_value_absent_is_none() {
        let args = vec!["app".into(), "--other".into()];
        assert_eq!(arg_value(&args, "--core-url"), None);
    }
}
