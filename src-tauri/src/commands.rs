use crate::sidecar::update_server_args_internal;
use crate::state::AppState;
use crate::types::{ServerStatus, WindowAlignment};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, State};

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

fn resolve_monitor(
    app: &AppHandle,
    monitor_id: &str,
) -> Result<tauri::Monitor, String> {
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
        .set_size(Size::Logical(LogicalSize::new(width as f64, mon_height as f64)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(Position::Logical(LogicalPosition::new(x as f64, mon_y as f64)))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn show_main_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

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

#[tauri::command]
pub fn resolve_path(handle: AppHandle, path: String) -> Result<String, String> {
    if path.starts_with('~') {
        let home = handle.path().home_dir().map_err(|e| e.to_string())?;
        let rest = &path[1..];
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
    let dir = home.join(".tomat").join("messages");
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
    std::fs::write(file_path, content).map_err(|e| e.to_string())?;
    Ok(session_id)
}

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

#[tauri::command]
pub async fn delete_chat_session(handle: AppHandle, session_id: String) -> Result<(), String> {
    let file_path = session_file_path(&handle, &session_id)?;

    if !file_path.exists() {
        return Err("Session not found".to_string());
    }

    std::fs::remove_file(file_path).map_err(|e| e.to_string())?;
    Ok(())
}

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

#[tauri::command]
pub async fn load_latest_chat_history(handle: AppHandle) -> Result<serde_json::Value, String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let history_dir = home.join(".tomat").join("messages");

    if !history_dir.exists() {
        return Ok(serde_json::json!(null));
    }

    let entries = std::fs::read_dir(history_dir).map_err(|e| e.to_string())?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|entry| entry.path()))
        .filter(|p| p.extension().map_or(false, |ext| ext == "json"))
        .collect();

    files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    if let Some(latest) = files.first() {
        let session_id = latest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let content = std::fs::read_to_string(latest).map_err(|e| e.to_string())?;

        // Try new format first, fall back to legacy (plain array)
        if let Ok(session) = serde_json::from_str::<SessionFile>(&content) {
            Ok(serde_json::json!(ChatHistoryResponse {
                session_id,
                title: session.title,
                context_usage: session.context_usage,
                messages: session.messages,
            }))
        } else {
            // Legacy: file is just a JSON array of messages
            let messages: serde_json::Value =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            Ok(serde_json::json!(ChatHistoryResponse {
                session_id,
                title: String::new(),
                context_usage: None,
                messages,
            }))
        }
    } else {
        Ok(serde_json::json!(null))
    }
}

// -------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------

#[tauri::command]
pub async fn save_settings(handle: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let settings_dir = home.join(".tomat");
    std::fs::create_dir_all(&settings_dir).map_err(|e| e.to_string())?;

    let settings_path = settings_dir.join("settings.json");
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_settings(handle: AppHandle) -> Result<serde_json::Value, String> {
    let home = handle.path().home_dir().map_err(|e| e.to_string())?;
    let settings_path = home.join(".tomat").join("settings.json");

    if !settings_path.exists() {
        return Ok(serde_json::json!(null));
    }

    let content = std::fs::read_to_string(settings_path).map_err(|e| e.to_string())?;
    let val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(val)
}

// -------------------------------------------------------------------
// File conversion (anytomd)
// -------------------------------------------------------------------

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
