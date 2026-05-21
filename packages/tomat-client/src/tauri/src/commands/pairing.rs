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

use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use std::process::Command;

const DEFAULT_CDN_BASE: &str = "https://au.tomat.ing";

#[tauri::command]
pub fn read_admin_token() -> AppResult<Option<String>> {
    let path = admin_token_path()?;
    match std::fs::read_to_string(&path) {
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

#[tauri::command]
pub async fn install_local_core() -> AppResult<String> {
    let url = installer_url();
    let output = tokio::task::spawn_blocking(move || run_installer(&url))
        .await
        .map_err(|e| AppError::external(format!("installer task panicked: {e}")))??;
    parse_pairing_code(&output)
}

fn installer_url() -> String {
    let base = std::env::var("TOMAT_CDN").unwrap_or_else(|_| DEFAULT_CDN_BASE.into());
    let suffix = if cfg!(windows) { "core.ps1" } else { "core.sh" };
    format!("{}/install/{}", base, suffix)
}

#[cfg(unix)]
fn run_installer(url: &str) -> AppResult<String> {
    let pipeline = format!("curl -fsSL '{}' | bash", url);
    let out = Command::new("bash").arg("-c").arg(&pipeline).output()?;
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
fn run_installer(url: &str) -> AppResult<String> {
    let ps = format!("iwr -useb '{}' | iex", url);
    let out = Command::new("powershell")
        .args(["-ExecutionPolicy", "Bypass", "-Command", &ps])
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
