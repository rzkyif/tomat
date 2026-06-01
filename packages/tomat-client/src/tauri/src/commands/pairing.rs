// Pairing-flow commands.
//
//  - `read_admin_token`: read ~/.tomat/<channel>/core/.admin-token off disk
//    so the client can mint pairing codes on the LOCAL core. Returns None if
//    the file doesn't exist (e.g. paired with a remote core).
//
//  - `install_local_core`: shells out to the R2-hosted install script for
//    the host platform, captures stdout, parses the printed pairing code,
//    and returns it. The script writes the binary, sets up the launchd /
//    systemd-user / scheduled-task service, mints the admin token, and hits
//    /api/v1/pairing/codes itself. This command is just the trampoline.
//
//  - `start_local_core`: idempotently make sure a locally-installed core
//    is running. Used at app boot for the "on-demand" install mode where
//    no system service was registered (the client owns liveness).

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::State;

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

#[tauri::command]
pub async fn install_local_core(
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
    let output =
        tokio::task::spawn_blocking(move || run_installer(&url, install_service, install_bind_all))
            .await
            .map_err(|e| AppError::external(format!("installer task panicked: {e}")))??;
    parse_pairing_code(&output)
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
fn run_installer(url: &str, service: bool, bind_all: bool) -> AppResult<String> {
    let pipeline = format!("curl -fsSL '{}' | bash", url);
    let out = Command::new("bash")
        .arg("-c")
        .arg(&pipeline)
        // Install into THIS client's channel so a beta client installs a beta
        // core (not stable). The installer bakes it into the service env.
        .env("TOMAT_CHANNEL", crate::channel::channel())
        .env("TOMAT_INSTALL_SERVICE", install_service_flag(service))
        .env("TOMAT_INSTALL_BIND_ALL", install_service_flag(bind_all))
        .output()?;
    if !out.status.success() {
        return Err(AppError::external(format!(
            "installer exited with status {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn run_installer(url: &str, service: bool, bind_all: bool) -> AppResult<String> {
    let ps = format!("iwr -useb '{}' | iex", url);
    let out = Command::new("powershell")
        .args(["-ExecutionPolicy", "Bypass", "-Command", &ps])
        // Install into THIS client's channel so a beta client installs a beta
        // core (not stable). The installer bakes it into the service env.
        .env("TOMAT_CHANNEL", crate::channel::channel())
        .env("TOMAT_INSTALL_SERVICE", install_service_flag(service))
        .env("TOMAT_INSTALL_BIND_ALL", install_service_flag(bind_all))
        .output()?;
    if !out.status.success() {
        return Err(AppError::external(format!(
            "installer exited with status {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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

fn local_core_binary() -> AppResult<PathBuf> {
    let home = std::env::home_dir()
        .ok_or_else(|| AppError::external("could not determine home directory"))?;
    // Channel-suffixed: beta's core lives at .../bin/tomat-core-beta(.exe).
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
/// (stable 7800, beta 7810, …). The UI uses it for the "on this computer"
/// install/pair flow so a beta client targets the beta core.
#[tauri::command]
pub fn local_core_base_url() -> String {
    format!("https://127.0.0.1:{}", crate::channel::core_port())
}

/// This channel's default local sidecar ports (llama / whisper). The UI uses
/// them as fallbacks when the paired core hasn't overridden llm.port/stt.port,
/// so a beta client talks to the beta sidecars (7711/7712), not stable's.
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
pub async fn start_local_core() -> AppResult<bool> {
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

    spawn_detached(&bin, &logs_dir)?;

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

#[cfg(unix)]
fn spawn_detached(bin: &std::path::Path, logs_dir: &std::path::Path) -> AppResult<()> {
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
    unsafe {
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
            .spawn()?;
    }
    Ok(())
}

#[cfg(unix)]
fn libc_setsid() -> i32 {
    // Bind to libc dynamically to avoid adding a libc dep just for this.
    unsafe extern "C" {
        fn setsid() -> i32;
    }
    unsafe { setsid() }
}

#[cfg(windows)]
fn spawn_detached(bin: &std::path::Path, logs_dir: &std::path::Path) -> AppResult<()> {
    use std::fs::OpenOptions;
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("core.stdout.log"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("core.stderr.log"))?;
    Command::new(bin)
        .stdout(stdout)
        .stderr(stderr)
        // Pass this client's channel so the on-demand core matches it (the
        // compiled-in channel isn't visible to the spawned process otherwise).
        .env("TOMAT_CHANNEL", crate::channel::channel())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()?;
    Ok(())
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
