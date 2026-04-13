use crate::sidecar::update_server_args_internal;
use crate::state::AppState;
use crate::types::{ServerStatus, WindowAlignment};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, State};

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("Invalid session ID".into());
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Session ID contains invalid characters".into());
    }
    Ok(())
}

fn resolve_monitor(app: &AppHandle, monitor_id: &str) -> Result<tauri::Monitor, String> {
    let all_monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary_monitor = app.primary_monitor().map_err(|e| e.to_string())?;

    let monitor = if monitor_id == "primary" {
        primary_monitor
    } else {
        all_monitors
            .iter()
            .find(|mon| {
                mon.name()
                    .map(|name| name.as_str() == monitor_id || name.contains(monitor_id))
                    .unwrap_or(false)
            })
            .cloned()
            .or_else(|| {
                monitor_id
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| all_monitors.get(index).cloned())
            })
            .or(primary_monitor)
    };

    monitor.ok_or_else(|| "No monitor available".to_string())
}

/// Move and resize the main window to fill the chosen monitor with the given alignment.
#[tauri::command]
pub fn position_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    monitor_id: String,
    alignment: WindowAlignment,
    width: Option<u32>,
) -> Result<(), String> {
    let monitor = resolve_monitor(&app, &monitor_id)?;
    let scale_factor = monitor.scale_factor();
    let mon_width = (monitor.size().width as f64 / scale_factor) as u32;
    let mon_height = (monitor.size().height as f64 / scale_factor) as u32;
    let mon_x = (monitor.position().x as f64 / scale_factor) as i32;
    let mon_y = (monitor.position().y as f64 / scale_factor) as i32;

    let width: u32 = width.unwrap_or(700).clamp(400, 1200);

    let mut x = mon_x;
    match alignment {
        WindowAlignment::Left => {}
        WindowAlignment::Center => {
            x += ((mon_width.saturating_sub(width)) / 2) as i32;
        }
        WindowAlignment::Right => {
            x += mon_width.saturating_sub(width) as i32;
        }
    }

    window
        .set_size(Size::Logical(LogicalSize::new(
            width as f64,
            mon_height as f64,
        )))
        .map_err(|e| e.to_string())?;
    window
        .set_position(Position::Logical(LogicalPosition::new(
            x as f64,
            mon_y as f64,
        )))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Show the main window, focus it, and broadcast a `window-visibility: true` event.
#[tauri::command]
pub fn show_main_window(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    let _ = app.emit("window-visibility", true);
    Ok(())
}

/// Hide the main window and broadcast a `window-visibility: false` event.
#[tauri::command]
pub fn hide_main_window(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    let _ = app.emit("window-visibility", false);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct CaptureMonitorInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "isPrimary")]
    pub is_primary: bool,
}

/// List attached monitors for the screen-capture picker.
#[tauri::command]
pub async fn list_capture_monitors() -> Result<Vec<CaptureMonitorInfo>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (idx, m) in monitors.iter().enumerate() {
        let id = m
            .id()
            .map(|v| v.to_string())
            .unwrap_or_else(|_| idx.to_string());
        let name = m.name().unwrap_or_else(|_| format!("Monitor {}", idx + 1));
        let is_primary = m.is_primary().unwrap_or(false);
        out.push(CaptureMonitorInfo {
            id,
            name,
            is_primary,
        });
    }
    Ok(out)
}

/// Capture the named monitor and return a base64-encoded PNG.
#[tauri::command]
pub async fn capture_monitor(monitor_id: String) -> Result<String, String> {
    use base64::Engine;
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors
        .into_iter()
        .enumerate()
        .find(|(idx, m)| {
            m.id()
                .ok()
                .map(|v| v.to_string() == monitor_id)
                .unwrap_or(false)
                || idx.to_string() == monitor_id
        })
        .map(|(_, m)| m)
        .ok_or_else(|| "Monitor not found".to_string())?;

    let image = monitor.capture_image().map_err(|e| e.to_string())?;

    let mut buf: Vec<u8> = Vec::new();
    let dyn_img = image::DynamicImage::ImageRgba8(image);
    dyn_img
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

/// Return a snapshot of each tracked sidecar's status. Used on startup
/// when the frontend reconciles against any already-running processes.
#[tauri::command]
pub async fn get_server_statuses(
    state: State<'_, AppState>,
) -> Result<HashMap<String, ServerStatus>, String> {
    let sidecars = state.0.sidecars.lock().map_err(|e| e.to_string())?;
    let mut statuses = HashMap::new();
    for (name, _) in sidecars.iter() {
        statuses.insert(name.clone(), ServerStatus::Running);
    }
    Ok(statuses)
}

/// (Re)launch a sidecar with the given args. Supersedes any previous instance.
#[tauri::command]
pub async fn update_server_args(
    handle: AppHandle,
    state: State<'_, AppState>,
    server: String,
    args: Vec<String>,
    model_path: Option<String>,
    mmproj_path: Option<String>,
    check_url: Option<String>,
) -> Result<(), String> {
    update_server_args_internal(
        handle,
        state.inner(),
        server,
        args,
        model_path,
        mmproj_path,
        check_url,
    )
    .await
}

/// Expand a leading `~` in the given path to the user's home directory.
#[tauri::command]
pub fn resolve_path(handle: AppHandle, path: String) -> Result<String, String> {
    if let Some(rest) = path.strip_prefix('~') {
        let home = handle.path().home_dir().map_err(|e| e.to_string())?;
        let rest = rest.trim_start_matches('/');
        Ok(home.join(rest).to_string_lossy().to_string())
    } else {
        Ok(std::path::Path::new(&path).to_string_lossy().to_string())
    }
}

// -------------------------------------------------------------------
// Session / Chat History — format: { title, contextUsage, messages }
// -------------------------------------------------------------------

fn history_dir(handle: &AppHandle) -> Result<PathBuf, String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".tomat").join("sessions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn session_file_path(handle: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    let dir = history_dir(handle)?;
    let file_path = dir.join(format!("{}.json", session_id));
    if !file_path.starts_with(&dir) {
        return Err("Invalid session path".into());
    }
    Ok(file_path)
}

fn read_session_file(path: &std::path::Path) -> Option<SessionFile> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<SessionFile>(&content).ok()
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SessionFile {
    pub title: String,
    #[serde(rename = "contextUsage")]
    pub context_usage: Option<serde_json::Value>,
    pub messages: serde_json::Value,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ChatHistoryResponse {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub title: String,
    #[serde(rename = "contextUsage")]
    pub context_usage: Option<serde_json::Value>,
    pub messages: serde_json::Value,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
}

/// Persist a chat session to `~/.tomat/sessions/<session_id>.json` atomically.
/// Returns the session ID (generated from the current timestamp when absent).
#[tauri::command]
pub async fn save_chat_history(
    handle: AppHandle,
    messages: serde_json::Value,
    session_id: Option<String>,
    title: Option<String>,
    context_usage: Option<serde_json::Value>,
) -> Result<String, String> {
    let session_id = session_id.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string()
    });

    let file_path = session_file_path(&handle, &session_id)?;

    // If file already exists, preserve existing title/contextUsage when not provided
    let (existing_title, existing_context) = if file_path.exists() {
        read_session_file(&file_path)
            .map(|s| (Some(s.title), s.context_usage))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    let session_file = SessionFile {
        title: title.or(existing_title).unwrap_or_default(),
        context_usage: context_usage.or(existing_context),
        messages,
    };

    let content = serde_json::to_string_pretty(&session_file).map_err(|e| e.to_string())?;
    // Atomic write: stage to a unique .tmp then rename. The pid+nanos suffix
    // prevents two concurrent saves of the same session from racing on the
    // same tmp path (which would otherwise clobber each other mid-write).
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = file_path.with_extension(format!("tmp.{}.{}", std::process::id(), suffix));
    tokio::fs::write(&tmp_path, content)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp_path, &file_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(session_id)
}

/// Update just the title on an existing session file (used by auto-titling).
#[tauri::command]
pub async fn save_session_title(
    handle: AppHandle,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let file_path = session_file_path(&handle, &session_id)?;

    if !file_path.exists() {
        return Err("Session not found".to_string());
    }

    let content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut session: SessionFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    session.title = title;

    let updated = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    std::fs::write(file_path, updated).map_err(|e| e.to_string())?;
    Ok(())
}

/// List all saved sessions, sorted by session ID (timestamp) ascending.
#[tauri::command]
pub async fn list_chat_sessions(handle: AppHandle) -> Result<Vec<SessionInfo>, String> {
    let dir = history_dir(&handle)?;

    if !dir.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut sessions: Vec<SessionInfo> = entries
        .filter_map(|e| {
            let entry = e.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? != "json" {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let title = read_session_file(&path)
                .map(|s| s.title)
                .unwrap_or_default();
            Some(SessionInfo { id, title })
        })
        .collect();

    // Sort by ID (timestamp) ascending
    sessions.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(sessions)
}

/// Remove a single session file from disk.
#[tauri::command]
pub async fn delete_chat_session(handle: AppHandle, session_id: String) -> Result<(), String> {
    let file_path = session_file_path(&handle, &session_id)?;

    if !file_path.exists() {
        return Err("Session not found".to_string());
    }

    std::fs::remove_file(file_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load the full contents of a specific session.
#[tauri::command]
pub async fn load_chat_session(
    handle: AppHandle,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let file_path = session_file_path(&handle, &session_id)?;

    if !file_path.exists() {
        return Err("Session not found".to_string());
    }

    let content = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let session: SessionFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    Ok(serde_json::json!(ChatHistoryResponse {
        session_id,
        title: session.title,
        context_usage: session.context_usage,
        messages: session.messages,
    }))
}

/// Load the most recent session, or `null` if none exist.
#[tauri::command]
pub async fn load_latest_chat_history(handle: AppHandle) -> Result<serde_json::Value, String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let history_dir = home.join(".tomat").join("sessions");

    if !history_dir.exists() {
        return Ok(serde_json::json!(null));
    }

    let entries = std::fs::read_dir(history_dir).map_err(|e| e.to_string())?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|entry| entry.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();

    files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    if let Some(latest) = files.first() {
        let session_id = latest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let content = std::fs::read_to_string(latest).map_err(|e| e.to_string())?;
        let session: SessionFile = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(serde_json::json!(ChatHistoryResponse {
            session_id,
            title: session.title,
            context_usage: session.context_usage,
            messages: session.messages,
        }))
    } else {
        Ok(serde_json::json!(null))
    }
}

// -------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------

// Settings whose values are secrets and must live in the OS keychain rather
// than ~/.tomat/settings.json. The frontend (which owns the settings schema)
// decides which keys are secret and passes them in on every call — Rust does
// not maintain its own list.
const KEYCHAIN_SERVICE: &str = "tomat";

fn keychain_set(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

fn keychain_get(key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn keychain_delete(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Persist user settings. `settings` is written verbatim to
/// `~/.tomat/settings.json`; every entry in `secrets` is routed to the OS
/// keychain (empty value → delete). Caller is responsible for ensuring no
/// secret-typed key appears in `settings`.
#[tauri::command]
pub async fn save_settings(
    handle: AppHandle,
    settings: serde_json::Value,
    secrets: HashMap<String, String>,
) -> Result<(), String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let settings_dir = home.join(".tomat");
    std::fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;

    if !matches!(settings, serde_json::Value::Object(_)) {
        return Err("settings must be a JSON object".into());
    }

    for (key, value) in &secrets {
        if value.is_empty() {
            keychain_delete(key)?;
        } else {
            keychain_set(key, value)?;
        }
    }

    let settings_path = settings_dir.join("settings.json");
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load user settings, merging in the named keychain entries.
#[tauri::command]
pub async fn load_settings(
    handle: AppHandle,
    secret_keys: Vec<String>,
) -> Result<serde_json::Value, String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let settings_path = home.join(".tomat").join("settings.json");

    let mut obj = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        match serde_json::from_str::<serde_json::Value>(&content).map_err(|e| e.to_string())? {
            serde_json::Value::Object(map) => map,
            _ => serde_json::Map::new(),
        }
    } else {
        serde_json::Map::new()
    };

    for key in &secret_keys {
        if let Some(v) = keychain_get(key)? {
            obj.insert(key.clone(), serde_json::Value::String(v));
        }
    }

    if obj.is_empty() && !settings_path.exists() {
        return Ok(serde_json::json!(null));
    }
    Ok(serde_json::Value::Object(obj))
}

// -------------------------------------------------------------------
// File conversion (anytomd)
// -------------------------------------------------------------------

/// Convert the file at `file_path` to Markdown for attachment as document context.
/// Size-capped at 50 MiB; extension-whitelisted.
#[tauri::command]
pub async fn convert_file_to_markdown(file_path: String) -> Result<String, String> {
    let canonical =
        std::fs::canonicalize(&file_path).map_err(|e| format!("Cannot resolve path: {e}"))?;

    let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    const MAX_SIZE: u64 = 50 * 1024 * 1024;
    if meta.len() > MAX_SIZE {
        return Err(format!("File too large ({} bytes, max 50MB)", meta.len()));
    }

    let allowed_exts = [
        "docx", "pptx", "xlsx", "xls", "csv", "html", "htm", "txt", "md", "json", "xml", "rst",
        "log", "toml", "yaml", "ini", "py", "rs", "js", "ts", "c", "cpp", "go", "java", "pdf",
    ];
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !allowed_exts.contains(&ext.as_str()) {
        return Err(format!("Unsupported file type: .{ext}"));
    }

    if ext == "pdf" {
        let text = pdf_extract::extract_text(&canonical)
            .map_err(|e| format!("Failed to extract PDF text: {e}"))?;
        return Ok(text);
    }

    let options = anytomd::ConversionOptions::default();
    let result = anytomd::convert_file(&canonical, &options).map_err(|e| e.to_string())?;
    Ok(result.markdown)
}

// -------------------------------------------------------------------
// Process metrics
// -------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct ProcessMetrics {
    pub pid: u32,
    pub rss_mb: f64,
    pub cpu_pct: f32,
    pub running: bool,
}

/// Return RSS and CPU% for each tracked sidecar plus the main process.
#[tauri::command]
pub async fn get_process_metrics(
    state: State<'_, AppState>,
) -> Result<HashMap<String, ProcessMetrics>, String> {
    let mut pids: Vec<(String, u32)> = {
        let sidecars = state.0.sidecars.lock().map_err(|e| e.to_string())?;
        sidecars
            .iter()
            .filter_map(|(name, s)| s.pid.map(|pid| (name.clone(), pid)))
            .collect()
    };

    if let Ok(main_pid) = sysinfo::get_current_pid() {
        pids.push(("main".to_string(), main_pid.as_u32()));
    }

    let mut out = HashMap::new();
    let mut sys = state.0.metrics.write().await;
    for (name, pid) in pids {
        let sys_pid = sysinfo::Pid::from_u32(pid);
        sys.refresh_process(sys_pid);
        if let Some(proc) = sys.process(sys_pid) {
            out.insert(
                name,
                ProcessMetrics {
                    pid,
                    rss_mb: proc.memory() as f64 / 1024.0 / 1024.0,
                    cpu_pct: proc.cpu_usage(),
                    running: true,
                },
            );
        } else {
            out.insert(
                name,
                ProcessMetrics {
                    pid,
                    rss_mb: 0.0,
                    cpu_pct: 0.0,
                    running: false,
                },
            );
        }
    }
    Ok(out)
}

// -------------------------------------------------------------------
// Storage: ~/.tomat/ tree listing + delete
// -------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StorageNode {
    File {
        name: String,
        path: String,
        size: u64,
    },
    Folder {
        name: String,
        path: String,
        size: u64,
        children: Vec<StorageNode>,
    },
}

#[derive(serde::Serialize)]
pub struct StorageTree {
    pub models: Vec<StorageNode>,
    pub sessions: Vec<StorageNode>,
    pub total_size: u64,
    pub models_size: u64,
    pub sessions_size: u64,
    pub settings_size: u64,
    pub root_path: String,
}

fn dir_size_recursive(path: &std::path::Path) -> u64 {
    let mut total: u64 = 0;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total += meta.len();
            } else if meta.is_dir() {
                total += dir_size_recursive(&p);
            }
        }
    }
    total
}

fn collect_file_nodes(dir: &std::path::Path, ext_filter: Option<&str>) -> Vec<StorageNode> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Some(ext) = ext_filter {
            let matches = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case(ext))
                .unwrap_or(false);
            if !matches {
                continue;
            }
        }
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        out.push(StorageNode::File {
            name,
            path: p.to_string_lossy().to_string(),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| storage_name(a).cmp(storage_name(b)));
    out
}

fn storage_name(node: &StorageNode) -> &str {
    match node {
        StorageNode::File { name, .. } => name.as_str(),
        StorageNode::Folder { name, .. } => name.as_str(),
    }
}

fn storage_size(node: &StorageNode) -> u64 {
    match node {
        StorageNode::File { size, .. } => *size,
        StorageNode::Folder { size, .. } => *size,
    }
}

fn build_models_tree(models_dir: &std::path::Path) -> Vec<StorageNode> {
    let mut out = Vec::new();
    let Ok(user_entries) = std::fs::read_dir(models_dir) else {
        return out;
    };

    for user_entry in user_entries.flatten() {
        let user_path = user_entry.path();
        if !user_path.is_dir() {
            continue;
        }
        let Ok(repo_entries) = std::fs::read_dir(&user_path) else {
            continue;
        };
        for repo_entry in repo_entries.flatten() {
            let repo_path = repo_entry.path();
            if !repo_path.is_dir() {
                continue;
            }
            let user_name = user_entry.file_name().to_string_lossy().to_string();
            let repo_name = repo_entry.file_name().to_string_lossy().to_string();
            let display_name = format!("{}/{}", user_name, repo_name);

            let mut gguf_files = collect_file_nodes(&repo_path, Some("gguf"));
            // Also include .bin files (whisper.cpp)
            gguf_files.extend(collect_file_nodes(&repo_path, Some("bin")));
            gguf_files.sort_by(|a, b| storage_name(a).cmp(storage_name(b)));

            let has_mmproj = gguf_files
                .iter()
                .any(|n| storage_name(n).to_ascii_lowercase().starts_with("mmproj"));

            if gguf_files.is_empty() {
                continue;
            }

            if has_mmproj || gguf_files.len() > 1 {
                let size: u64 = gguf_files.iter().map(storage_size).sum();
                out.push(StorageNode::Folder {
                    name: display_name,
                    path: repo_path.to_string_lossy().to_string(),
                    size,
                    children: gguf_files,
                });
            } else {
                // Single file: show as flat line "user/repo/filename"
                let file = gguf_files.into_iter().next().unwrap();
                if let StorageNode::File {
                    name: fname,
                    path,
                    size,
                } = file
                {
                    out.push(StorageNode::File {
                        name: format!("{}/{}", display_name, fname),
                        path,
                        size,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| storage_name(a).cmp(storage_name(b)));
    out
}

fn build_sessions_tree(sessions_dir: &std::path::Path) -> Vec<StorageNode> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let is_json = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let title = read_session_file(&p).map(|s| s.title).unwrap_or_default();
        let display = if title.trim().is_empty() { stem } else { title };
        out.push(StorageNode::File {
            name: display,
            path: p.to_string_lossy().to_string(),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| storage_name(a).cmp(storage_name(b)));
    out
}

/// Enumerate everything under `~/.tomat/` for the storage UI.
#[tauri::command]
pub async fn list_tomat_storage(handle: AppHandle) -> Result<StorageTree, String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let root = home.join(".tomat");
    let models_dir = root.join("models");
    let sessions_dir = root.join("sessions");

    let models = build_models_tree(&models_dir);
    let sessions = build_sessions_tree(&sessions_dir);

    let models_size: u64 = models.iter().map(storage_size).sum();
    let sessions_size: u64 = sessions.iter().map(storage_size).sum();
    let settings_size = std::fs::metadata(root.join("settings.json"))
        .map(|m| m.len())
        .unwrap_or(0);
    let total_size = dir_size_recursive(&root);

    Ok(StorageTree {
        models,
        sessions,
        total_size,
        models_size,
        sessions_size,
        settings_size,
        root_path: root.to_string_lossy().to_string(),
    })
}

/// Returns Some(canonical_path) if `path` resolves inside `root`, else None.
/// Both arguments are canonicalized to defeat symlink-based path traversal.
fn resolve_within(path: &std::path::Path, root_canonical: &std::path::Path) -> Option<PathBuf> {
    let p = path.canonicalize().ok()?;
    if p.starts_with(root_canonical) {
        Some(p)
    } else {
        None
    }
}

/// Delete the given paths. Every path is canonicalized and must resolve under `~/.tomat/`.
#[tauri::command]
pub async fn delete_tomat_paths(handle: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let root_canonical = home
        .join(".tomat")
        .canonicalize()
        .map_err(|e| e.to_string())?;

    for path_str in paths {
        let p = PathBuf::from(&path_str);
        let canonical = resolve_within(&p, &root_canonical)
            .ok_or_else(|| format!("Path not under ~/.tomat: {}", path_str))?;
        let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&canonical).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&canonical).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Remove all downloaded models from `~/.tomat/models/`.
#[tauri::command]
pub async fn clear_tomat_models(handle: AppHandle) -> Result<(), String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".tomat").join("models");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove every saved session from `~/.tomat/sessions/`.
#[tauri::command]
pub async fn clear_tomat_sessions(handle: AppHandle) -> Result<(), String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".tomat").join("sessions");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// Wipe the settings file and every keychain entry the caller names.
#[tauri::command]
pub async fn clear_tomat_settings(
    handle: AppHandle,
    secret_keys: Vec<String>,
) -> Result<(), String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let path = home.join(".tomat").join("settings.json");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    for key in &secret_keys {
        keychain_delete(key)?;
    }
    Ok(())
}
