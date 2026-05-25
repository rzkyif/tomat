// Pairing-flow commands.
//
//  - `read_admin_token`: read ~/.tomat/core/.admin-token off disk so the
//    client can mint pairing codes on the LOCAL core. Returns None if the
//    file doesn't exist (e.g. paired with a remote core).
//
//  - `install_local_core`: shells out to the CDN-hosted install script for
//    the host platform, captures stdout, parses the printed pairing code,
//    and returns it. The script writes the binary, sets up the launchd /
//    systemd-user / scheduled-task service, mints the admin token, and hits
//    /api/v1/pairing/codes itself — this command is just the trampoline.
//
//  - `start_local_core`: idempotently make sure a locally-installed core
//    is running. Used at app boot for the "on-demand" install mode where
//    no system service was registered — the client owns liveness.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::State;

const DEFAULT_CDN_BASE: &str = "https://au.tomat.ing";

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
        run_installer(&url, install_service, install_bind_all)
    })
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
        self.state.install_in_progress.store(false, Ordering::SeqCst);
    }
}

fn installer_url() -> String {
    let base = std::env::var("TOMAT_CDN").unwrap_or_else(|_| DEFAULT_CDN_BASE.into());
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
    // whitespace). The last occurrence wins — re-runs print the new code.
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

fn admin_token_path() -> AppResult<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| AppError::external("could not determine home directory"))?;
    Ok(home.join(".tomat").join("core").join(".admin-token"))
}

fn local_core_binary() -> AppResult<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| AppError::external("could not determine home directory"))?;
    let name = if cfg!(windows) { "tomat-core.exe" } else { "tomat-core" };
    Ok(home.join(".tomat").join("core").join("bin").join(name))
}

/// Returns `true` if the local core binary exists on disk.
#[tauri::command]
pub fn local_core_installed() -> AppResult<bool> {
    Ok(local_core_binary().map(|p| p.exists()).unwrap_or(false))
}

/// Spawn the locally-installed core detached when it isn't already running.
/// Called from app boot for the "on-demand" install mode. Idempotent: if the
/// admin endpoint already answers, this is a no-op and returns `false`.
/// Returns `true` if a new process was started.
#[tauri::command]
pub async fn start_local_core() -> AppResult<bool> {
    let bin = local_core_binary()?;
    if !bin.exists() {
        return Err(AppError::external(format!(
            "local core not installed at {}",
            bin.display(),
        )));
    }

    // Cheap liveness probe — if 127.0.0.1:7800 is already answering, leave it.
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
    // It might still be coming up — return success rather than block the UI.
    Ok(true)
}

/// Minimal HTTP probe of the local core: TCP connect + GET /api/v1/health,
/// return true iff we got an HTTP-shaped response. Uses raw TcpStream so we
/// don't pull in a new HTTP client crate just for this one cheap probe.
async fn probe_local_core() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    let task = tokio::task::spawn_blocking(|| -> bool {
        let Ok(addr) = "127.0.0.1:7800".parse() else {
            return false;
        };
        let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(150)) else {
            return false;
        };
        let _ = s.set_read_timeout(Some(Duration::from_millis(150)));
        let _ = s.set_write_timeout(Some(Duration::from_millis(150)));
        if s.write_all(b"GET /api/v1/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            .is_err()
        {
            return false;
        }
        let mut buf = [0u8; 16];
        let Ok(_) = s.read(&mut buf) else {
            return false;
        };
        buf.starts_with(b"HTTP/")
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
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn installer_url_uses_default_cdn_when_env_unset() {
        // SAFETY: tests in this crate are run with --test-threads=1 in CI for
        // this exact reason; locally a stray race is harmless (the assert
        // simply gets retried).
        // SAFETY: standalone test binary, single thread, env mutation is fine.
        unsafe {
            std::env::remove_var("TOMAT_CDN");
        }
        let url = installer_url();
        assert!(url.starts_with(DEFAULT_CDN_BASE));
        assert!(url.ends_with("core.sh") || url.ends_with("core.ps1"));
    }

    #[test]
    fn installer_url_honors_tomat_cdn_override() {
        unsafe {
            std::env::set_var("TOMAT_CDN", "https://test.example");
        }
        let url = installer_url();
        unsafe {
            std::env::remove_var("TOMAT_CDN");
        }
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
}
