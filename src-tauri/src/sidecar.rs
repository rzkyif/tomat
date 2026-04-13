use crate::state::{AppState, Sidecar};
use crate::types::{ServerStatus, ServerStatusUpdate};
use crate::utils::current_target_triple;
use futures_util::StreamExt;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Grace period between SIGTERM and SIGKILL when superseding an old sidecar.
// Unix-only: Windows has no SIGTERM equivalent and skips the grace period.
#[cfg(unix)]
const GRACEFUL_SHUTDOWN_SECS: u64 = 5;

pub fn shared_library_dir<R: Runtime>(handle: &AppHandle<R>) -> Result<PathBuf, String> {
    let triple = current_target_triple()?;
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(triple))
    } else {
        Ok(handle
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("binaries")
            .join(triple))
    }
}

pub fn apply_runtime_library_path<R: Runtime>(
    handle: &AppHandle<R>,
    cmd: tauri_plugin_shell::process::Command,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let lib_dir = shared_library_dir(handle)?;
    if !lib_dir.exists() {
        return Ok(cmd);
    }

    let lib_dir_str = lib_dir.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        let existing = std::env::var("DYLD_LIBRARY_PATH").ok();
        let value = match existing {
            Some(path) if !path.is_empty() => format!("{lib_dir_str}:{path}"),
            _ => lib_dir_str,
        };
        return Ok(cmd.env("DYLD_LIBRARY_PATH", value));
    }

    #[cfg(target_os = "linux")]
    {
        let existing = std::env::var("LD_LIBRARY_PATH").ok();
        let value = match existing {
            Some(path) if !path.is_empty() => format!("{lib_dir_str}:{path}"),
            _ => lib_dir_str,
        };
        return Ok(cmd.env("LD_LIBRARY_PATH", value));
    }

    #[cfg(target_os = "windows")]
    {
        let separator = ";";
        let existing = std::env::var("PATH").ok();
        let value = match existing {
            Some(path) if !path.is_empty() => format!("{lib_dir_str}{separator}{path}"),
            _ => lib_dir_str,
        };
        return Ok(cmd.env("PATH", value));
    }

    #[allow(unreachable_code)]
    Ok(cmd)
}

pub async fn emit_status<R: Runtime>(
    handle: &AppHandle<R>,
    server: &str,
    status: ServerStatus,
    progress: Option<f64>,
    message: Option<String>,
) {
    let _ = handle.emit(
        "sidecar-status",
        ServerStatusUpdate {
            server: server.to_string(),
            status,
            progress,
            message,
        },
    );
}

pub fn is_current_start(state: &AppState, server: &str, start_id: u64) -> bool {
    match state.0.sidecars.lock() {
        Ok(sidecars) => sidecars
            .get(server)
            .map(|sidecar| sidecar.start_id == start_id)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Validate a sidecar health-check URL. Only accepts `http://` pointing at
/// `127.0.0.1` or `localhost` - external endpoints are intentionally rejected
/// to keep sidecar supervision local to the user's machine.
fn validate_health_check_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid health check URL: {e}"))?;
    if parsed.scheme() != "http" {
        return Err("Health check URL must use http scheme".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Health check URL missing host".to_string())?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("Health check URL must point to localhost".into());
    }
    Ok(())
}

// Graceful termination on Unix: send SIGTERM so the child can flush buffers
// and close sockets, wait for the grace period, then SIGKILL via child.kill().
// Windows has no SIGTERM equivalent, so we skip the grace period entirely -
// otherwise we'd idle for GRACEFUL_SHUTDOWN_SECS with no signal sent, just
// slowing sidecar replacement.
#[cfg(unix)]
fn send_sigterm(pid: u32) {
    let _ = std::process::Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
}

fn terminate_child_detached(pid: u32, child: CommandChild) {
    tauri::async_runtime::spawn(async move {
        #[cfg(unix)]
        {
            send_sigterm(pid);
            tokio::time::sleep(std::time::Duration::from_secs(GRACEFUL_SHUTDOWN_SECS)).await;
        }
        #[cfg(not(unix))]
        let _ = pid;

        if let Err(e) = child.kill() {
            eprintln!("[sidecar] child.kill() failed: {e}");
        }
        // CommandChild dropped here - tauri-plugin-shell reaps the underlying
        // tokio::process::Child internally.
    });
}

pub async fn update_server_args_internal<R: Runtime>(
    handle: AppHandle<R>,
    state: &AppState,
    server: String,
    args: Vec<String>,
    model_path: Option<String>,
    mmproj_path: Option<String>,
    check_url: Option<String>,
) -> Result<(), String> {
    let (current_start_id, old_child, old_pid) = {
        let mut sidecars = state.0.sidecars.lock().map_err(|e| e.to_string())?;
        let sidecar = sidecars.entry(server.clone()).or_insert(Sidecar {
            child: None,
            start_id: 0,
            pid: None,
        });

        sidecar.start_id += 1;
        let old_child = sidecar.child.take();
        let old_pid = sidecar.pid.take();
        (sidecar.start_id, old_child, old_pid)
    };

    if let (Some(child), Some(pid)) = (old_child, old_pid) {
        terminate_child_detached(pid, child);
    }

    if let Some(ref url) = check_url {
        validate_health_check_url(url)?;
    }

    if args.is_empty() && server != "bun" {
        emit_status(&handle, &server, ServerStatus::Disabled, None, None).await;
        return Ok(());
    }

    let handle_clone = handle.clone();
    let server_clone = server.clone();
    let state_clone = state.clone();

    tauri::async_runtime::spawn(async move {
        let actual_model_path = if let Some(mp) = model_path {
            if mp.is_empty() {
                None
            } else {
                match ensure_model_internal(
                    &handle_clone,
                    &state_clone,
                    &server_clone,
                    &mp,
                    current_start_id,
                )
                .await
                {
                    Ok(path) => Some(path),
                    Err(_) if !is_current_start(&state_clone, &server_clone, current_start_id) => {
                        return;
                    }
                    Err(e) => {
                        emit_status(
                            &handle_clone,
                            &server_clone,
                            ServerStatus::Error,
                            None,
                            Some(e),
                        )
                        .await;
                        return;
                    }
                }
            }
        } else {
            None
        };

        let actual_mmproj_path = if let Some(mp) = mmproj_path {
            if mp.is_empty() {
                None
            } else {
                match ensure_model_internal(
                    &handle_clone,
                    &state_clone,
                    &server_clone,
                    &mp,
                    current_start_id,
                )
                .await
                {
                    Ok(path) => Some(path),
                    Err(_) if !is_current_start(&state_clone, &server_clone, current_start_id) => {
                        return;
                    }
                    Err(e) => {
                        emit_status(
                            &handle_clone,
                            &server_clone,
                            ServerStatus::Error,
                            None,
                            Some(e),
                        )
                        .await;
                        return;
                    }
                }
            }
        } else {
            None
        };

        // Re-check start_id
        if !is_current_start(&state_clone, &server_clone, current_start_id) {
            return;
        }

        emit_status(
            &handle_clone,
            &server_clone,
            ServerStatus::Loading,
            None,
            Some("Starting server...".into()),
        )
        .await;

        let mut final_args: Vec<String> = Vec::with_capacity(args.len());
        for a in args {
            if a == "__MODEL_PATH__" {
                final_args.push(actual_model_path.clone().unwrap_or_default());
            } else if a == "__MMPROJ_PATH__" {
                if let Some(p) = actual_mmproj_path.clone() {
                    final_args.push(p);
                }
            } else if a == "--mmproj" && actual_mmproj_path.is_none() {
                continue;
            } else {
                final_args.push(a);
            }
        }

        let sidecar_name = if server_clone == "llm" {
            "tomat-llama-server"
        } else if server_clone == "stt" {
            "tomat-whisper-server"
        } else {
            "tomat-tools-server"
        };

        let cmd = match handle_clone.shell().sidecar(sidecar_name) {
            Ok(cmd) => cmd.args(final_args),
            Err(e) => {
                emit_status(
                    &handle_clone,
                    &server_clone,
                    ServerStatus::Error,
                    None,
                    Some(format!("Failed to prepare sidecar: {e}")),
                )
                .await;
                return;
            }
        };

        let cmd = match apply_runtime_library_path(&handle_clone, cmd) {
            Ok(cmd) => cmd,
            Err(e) => {
                emit_status(
                    &handle_clone,
                    &server_clone,
                    ServerStatus::Error,
                    None,
                    Some(e),
                )
                .await;
                return;
            }
        };

        let (mut rx, child) = match cmd.spawn() {
            Ok(result) => result,
            Err(e) => {
                emit_status(
                    &handle_clone,
                    &server_clone,
                    ServerStatus::Error,
                    None,
                    Some(format!("Failed to spawn sidecar: {e}")),
                )
                .await;
                return;
            }
        };

        // Poisoned-mutex handling is isolated in this block so the PoisonError
        // (which holds a !Send MutexGuard) is fully dropped before any await.
        let poison_msg: Option<String> = match state_clone.0.sidecars.lock() {
            Ok(mut s_lock) => {
                if let Some(s) = s_lock.get_mut(&server_clone) {
                    if s.start_id == current_start_id {
                        s.pid = Some(child.pid());
                        s.child = Some(child);
                    } else {
                        let _ = child.kill();
                        return;
                    }
                }
                None
            }
            Err(e) => {
                eprintln!("[sidecar] mutex poisoned: {e}");
                let _ = child.kill();
                Some("Internal state corrupted, restart required".into())
            }
        };
        if let Some(msg) = poison_msg {
            emit_status(
                &handle_clone,
                &server_clone,
                ServerStatus::Error,
                None,
                Some(msg),
            )
            .await;
            return;
        }

        // Monitor output
        let handle_inner = handle_clone.clone();
        let server_inner = server_clone.clone();
        let state_for_output = state_clone.clone();
        tauri::async_runtime::spawn(async move {
            let mut recent_logs: Vec<String> = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        let text = String::from_utf8_lossy(&bytes);
                        for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
                            recent_logs.push(line.to_string());
                            if recent_logs.len() > 10 {
                                recent_logs.remove(0);
                            }
                        }
                    }
                    CommandEvent::Error(e) => {
                        if is_current_start(&state_for_output, &server_inner, current_start_id) {
                            emit_status(
                                &handle_inner,
                                &server_inner,
                                ServerStatus::Error,
                                None,
                                Some(e),
                            )
                            .await;
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        if is_current_start(&state_for_output, &server_inner, current_start_id) {
                            let message = if recent_logs.is_empty() {
                                format!(
                                    "Server exited before becoming ready (code {:?})",
                                    payload.code
                                )
                            } else {
                                recent_logs.join("\n")
                            };
                            emit_status(
                                &handle_inner,
                                &server_inner,
                                ServerStatus::Error,
                                None,
                                Some(message),
                            )
                            .await;
                        }
                    }
                    _ => {}
                }
            }
        });

        if let Some(url) = check_url {
            let mut healthy = false;
            for _ in 0..30 {
                if let Ok(res) = reqwest::get(&url).await {
                    if res.status().is_success() {
                        healthy = true;
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;

                // Check if we were superseded
                if !is_current_start(&state_clone, &server_clone, current_start_id) {
                    return;
                }
            }
            if healthy {
                emit_status(
                    &handle_clone,
                    &server_clone,
                    ServerStatus::Running,
                    None,
                    None,
                )
                .await;
            } else {
                emit_status(
                    &handle_clone,
                    &server_clone,
                    ServerStatus::Error,
                    None,
                    Some("Health check timed out".into()),
                )
                .await;
            }
        } else {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            emit_status(
                &handle_clone,
                &server_clone,
                ServerStatus::Running,
                None,
                None,
            )
            .await;
        }
    });

    Ok(())
}

pub async fn ensure_model_internal<R: Runtime>(
    handle: &AppHandle<R>,
    state: &AppState,
    server: &str,
    model_path: &str,
    start_id: u64,
) -> Result<String, String> {
    if !model_path.starts_with('@') {
        let path = std::path::Path::new(model_path);
        if path.exists() {
            return Ok(model_path.to_string());
        } else {
            return Err(format!("Model path does not exist: {}", model_path));
        }
    }

    // @username/reponame/branchname/filename
    let parts: Vec<&str> = model_path[1..].split('/').collect();
    if parts.len() < 4 {
        return Err("Invalid model path format".into());
    }

    let username = parts[0];
    let reponame = parts[1];
    let branchname = parts[2];
    let filename = parts[3..].join("/");

    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let dest_dir = home
        .join(".tomat")
        .join("models")
        .join(username)
        .join(reponame);
    let dest_path = dest_dir.join(&filename);

    if dest_path.exists() {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    emit_status(
        handle,
        server,
        ServerStatus::Loading,
        None,
        Some("Waiting for download slot...".into()),
    )
    .await;

    let _download_guard = state
        .0
        .download_sem
        .acquire()
        .await
        .map_err(|e| e.to_string())?;

    if !is_current_start(state, server, start_id) {
        return Err("Download cancelled".to_string());
    }

    if dest_path.exists() {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    emit_status(
        handle,
        server,
        ServerStatus::Downloading,
        Some(0.0),
        Some(format!("Downloading {}...", filename)),
    )
    .await;

    let url = format!(
        "https://huggingface.co/{}/{}/resolve/{}/{}?download=true",
        username, reponame, branchname, filename
    );

    let client = reqwest::Client::new();
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Failed to download model: {}", res.status()));
    }

    let total_size = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    let tmp_path = dest_path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| e.to_string())?;

    while let Some(item) = stream.next().await {
        if !is_current_start(state, server, start_id) {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err("Download cancelled".to_string());
        }

        let chunk = item.map_err(|e| e.to_string())?;
        tokio::io::copy(&mut &chunk[..], &mut file)
            .await
            .map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;
            emit_status(
                handle,
                server,
                ServerStatus::Downloading,
                Some(progress),
                Some(format!(
                    "Downloading {} ({:.2} MB)...",
                    filename,
                    downloaded as f64 / 1024.0 / 1024.0
                )),
            )
            .await;
        }
    }

    std::fs::rename(tmp_path, &dest_path).map_err(|e| e.to_string())?;

    Ok(dest_path.to_string_lossy().to_string())
}

/// Download a single Hugging Face path into the shared model cache, emitting
/// progress as `<server>` sidecar-status events. Unlike `ensure_model_internal`
/// this is not gated on a sidecar start_id - intended for one-shot fetches
/// (e.g. TTS assets) that don't restart a process when they finish.
pub async fn ensure_path_internal<R: Runtime>(
    handle: &AppHandle<R>,
    state: &AppState,
    server: &str,
    path: &str,
) -> Result<String, String> {
    if !path.starts_with('@') {
        let p = std::path::Path::new(path);
        if p.exists() {
            return Ok(path.to_string());
        }
        return Err(format!("Path does not exist: {}", path));
    }

    let parts: Vec<&str> = path[1..].split('/').collect();
    if parts.len() < 4 {
        return Err("Invalid model path format".into());
    }
    let username = parts[0];
    let reponame = parts[1];
    let branchname = parts[2];
    let filename = parts[3..].join("/");

    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let dest_dir = home
        .join(".tomat")
        .join("models")
        .join(username)
        .join(reponame);
    let dest_path = dest_dir.join(&filename);

    if dest_path.exists() {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    emit_status(
        handle,
        server,
        ServerStatus::Loading,
        None,
        Some("Waiting for download slot...".into()),
    )
    .await;

    let _download_guard = state
        .0
        .download_sem
        .acquire()
        .await
        .map_err(|e| e.to_string())?;

    if dest_path.exists() {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    emit_status(
        handle,
        server,
        ServerStatus::Downloading,
        Some(0.0),
        Some(format!("Downloading {}...", filename)),
    )
    .await;

    let url = format!(
        "https://huggingface.co/{}/{}/resolve/{}/{}?download=true",
        username, reponame, branchname, filename
    );

    let client = reqwest::Client::new();
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Failed to download asset: {}", res.status()));
    }

    let total_size = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    let tmp_path = dest_path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| e.to_string())?;

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| e.to_string())?;
        tokio::io::copy(&mut &chunk[..], &mut file)
            .await
            .map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;
            emit_status(
                handle,
                server,
                ServerStatus::Downloading,
                Some(progress),
                Some(format!(
                    "Downloading {} ({:.2} MB)...",
                    filename,
                    downloaded as f64 / 1024.0 / 1024.0
                )),
            )
            .await;
        }
    }

    std::fs::rename(tmp_path, &dest_path).map_err(|e| e.to_string())?;

    Ok(dest_path.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
pub struct DownloadPlan {
    pub path: String,
    pub url: String,
    pub filename: String,
    pub size_bytes: Option<u64>,
    pub already_downloaded: bool,
}

pub async fn probe_download<R: Runtime>(
    handle: &AppHandle<R>,
    path: &str,
) -> Result<DownloadPlan, String> {
    if !path.starts_with('@') {
        let p = std::path::Path::new(path);
        return Ok(DownloadPlan {
            path: path.to_string(),
            url: String::new(),
            filename: p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string()),
            size_bytes: None,
            already_downloaded: p.exists(),
        });
    }

    let parts: Vec<&str> = path[1..].split('/').collect();
    if parts.len() < 4 {
        return Err("Invalid model path format".into());
    }
    let username = parts[0];
    let reponame = parts[1];
    let branchname = parts[2];
    let filename = parts[3..].join("/");

    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let dest_path = home
        .join(".tomat")
        .join("models")
        .join(username)
        .join(reponame)
        .join(&filename);

    if dest_path.exists() {
        return Ok(DownloadPlan {
            path: path.to_string(),
            url: String::new(),
            filename,
            size_bytes: None,
            already_downloaded: true,
        });
    }

    let url = format!(
        "https://huggingface.co/{}/{}/resolve/{}/{}?download=true",
        username, reponame, branchname, filename
    );

    // HF resolve URLs 302-redirect to a CDN that often omits Content-Length on
    // HEAD. The 302 response itself carries the LFS file size in
    // `x-linked-size`, so probe with redirects disabled first and fall back to
    // following redirects if HF didn't set it.
    let no_redirect = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let size_bytes = match no_redirect.head(&url).send().await {
        Ok(res) => res
            .headers()
            .get("x-linked-size")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| res.content_length()),
        _ => None,
    };
    let size_bytes = match size_bytes {
        Some(n) => Some(n),
        None => match reqwest::Client::new().head(&url).send().await {
            Ok(res) if res.status().is_success() => res.content_length(),
            _ => None,
        },
    };

    Ok(DownloadPlan {
        path: path.to_string(),
        url,
        filename,
        size_bytes,
        already_downloaded: false,
    })
}

#[tauri::command]
pub async fn probe_downloads(
    handle: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<DownloadPlan>, String> {
    let futures = paths.iter().map(|p| probe_download(&handle, p));
    let results = futures_util::future::join_all(futures).await;
    let mut out = Vec::with_capacity(results.len());
    for r in results {
        match r {
            Ok(plan) => out.push(plan),
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}
