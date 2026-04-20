//! Chat session CRUD and per-session attachment I/O.
//!
//! Sessions live under `~/.tomat/sessions/<id>/` with `messages.json`
//! plus any attachment blobs. All writes stage to a unique `.tmp` and
//! rename for atomicity; filename conflicts auto-suffix via `-1`, `-2`, ….

use crate::commands::paths::{resolve_within, sanitize_attachment_name, validate_session_id};
use crate::error::{AppError, AppResult};
use crate::sidecar::MAX_UNIQUE_SUFFIX_ATTEMPTS;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

async fn history_dir(handle: &AppHandle) -> AppResult<PathBuf> {
    let home = handle.path().home_dir()?;
    let dir = home.join(".tomat").join("sessions");
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

async fn session_dir(handle: &AppHandle, session_id: &str) -> AppResult<PathBuf> {
    validate_session_id(session_id)?;
    let dir = history_dir(handle).await?.join(session_id);
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

async fn session_file_path(handle: &AppHandle, session_id: &str) -> AppResult<PathBuf> {
    Ok(session_dir(handle, session_id).await?.join("messages.json"))
}

pub(crate) async fn read_session_file(path: &Path) -> Option<SessionFile> {
    let content = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<SessionFile>(&content).ok()
}

/// Blocking variant for use inside synchronous directory walks (the storage
/// tree builders). Issuing a tokio task per file would be heavier than the
/// cost of blocking reads there.
pub(crate) fn read_session_file_sync(path: &Path) -> Option<SessionFile> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<SessionFile>(&content).ok()
}

/// Resolve `<session_dir>/<prefix>-<filename>`, appending `-1`, `-2`, …
/// before the extension until an unused path is found. Capped at
/// `MAX_UNIQUE_SUFFIX_ATTEMPTS` to bound worst-case cost.
fn unique_attachment_path(dir: &Path, prefix: &str, name: &str) -> PathBuf {
    let candidate = format!("{prefix}-{name}");
    let path = dir.join(&candidate);
    if !path.exists() {
        return path;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..MAX_UNIQUE_SUFFIX_ATTEMPTS {
        let alt = format!("{prefix}-{stem}-{i}{ext}");
        let p = dir.join(&alt);
        if !p.exists() {
            return p;
        }
    }
    path
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
) -> AppResult<String> {
    let session_id = session_id.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string()
    });

    let file_path = session_file_path(&handle, &session_id).await?;

    // If file already exists, preserve existing title/contextUsage when not provided
    let (existing_title, existing_context) = if file_path.exists() {
        read_session_file(&file_path)
            .await
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

    let content = serde_json::to_string_pretty(&session_file)?;
    // Atomic write: stage to a unique .tmp then rename. The pid+nanos suffix
    // prevents two concurrent saves of the same session from racing on the
    // same tmp path (which would otherwise clobber each other mid-write).
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = file_path.with_extension(format!("tmp.{}.{}", std::process::id(), suffix));
    tokio::fs::write(&tmp_path, content).await?;
    tokio::fs::rename(&tmp_path, &file_path).await?;
    Ok(session_id)
}

/// Update just the title on an existing session file (used by auto-titling).
#[tauri::command]
pub async fn save_session_title(
    handle: AppHandle,
    session_id: String,
    title: String,
) -> AppResult<()> {
    let file_path = session_file_path(&handle, &session_id).await?;

    if !file_path.exists() {
        return Err(AppError::not_found("Session not found"));
    }

    let content = tokio::fs::read_to_string(&file_path).await?;
    let mut session: SessionFile = serde_json::from_str(&content)?;
    session.title = title;

    let updated = serde_json::to_string_pretty(&session)?;
    tokio::fs::write(file_path, updated).await?;
    Ok(())
}

/// List all saved sessions, sorted by session ID (timestamp) ascending.
#[tauri::command]
pub async fn list_chat_sessions(handle: AppHandle) -> AppResult<Vec<SessionInfo>> {
    let dir = history_dir(&handle).await?;

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions: Vec<SessionInfo> = Vec::new();
    let mut reader = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = reader.next_entry().await? {
        let path = entry.path();
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_dir() {
            continue;
        }
        let id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if validate_session_id(&id).is_err() {
            continue;
        }
        let messages_path = path.join("messages.json");
        let title = read_session_file(&messages_path)
            .await
            .map(|s| s.title)
            .unwrap_or_default();
        sessions.push(SessionInfo { id, title });
    }

    sessions.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(sessions)
}

/// Remove a single session directory (messages.json and any attachments) from disk.
#[tauri::command]
pub async fn delete_chat_session(handle: AppHandle, session_id: String) -> AppResult<()> {
    let dir = session_dir(&handle, &session_id).await?;

    if !dir.exists() {
        return Err(AppError::not_found("Session not found"));
    }

    tokio::fs::remove_dir_all(dir).await?;
    Ok(())
}

/// Load the full contents of a specific session.
#[tauri::command]
pub async fn load_chat_session(
    handle: AppHandle,
    session_id: String,
) -> AppResult<serde_json::Value> {
    let file_path = session_file_path(&handle, &session_id).await?;

    if !file_path.exists() {
        return Err(AppError::not_found("Session not found"));
    }

    let content = tokio::fs::read_to_string(&file_path).await?;
    let session: SessionFile = serde_json::from_str(&content)?;

    Ok(serde_json::json!(ChatHistoryResponse {
        session_id,
        title: session.title,
        context_usage: session.context_usage,
        messages: session.messages,
    }))
}

/// Load the most recent session, or `null` if none exist.
#[tauri::command]
pub async fn load_latest_chat_history(handle: AppHandle) -> AppResult<serde_json::Value> {
    let home = handle.path().home_dir()?;
    let history_dir = home.join(".tomat").join("sessions");

    if !history_dir.exists() {
        return Ok(serde_json::json!(null));
    }

    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut reader = tokio::fs::read_dir(&history_dir).await?;
    while let Some(entry) = reader.next_entry().await? {
        let p = entry.path();
        if p.is_dir() && p.join("messages.json").exists() {
            dirs.push(p);
        }
    }

    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    if let Some(latest) = dirs.first() {
        let session_id = latest
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let messages_path = latest.join("messages.json");
        let content = tokio::fs::read_to_string(&messages_path).await?;
        let session: SessionFile = serde_json::from_str(&content)?;
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
// Session attachments
// -------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct WrittenAttachment {
    pub path: String,
    pub filename: String,
}

/// Write an attachment blob into the session's directory and return its absolute path.
/// `data_base64` is the payload encoded as standard base64. Filename collisions
/// are resolved by appending `-1`, `-2`, ... before the extension.
#[tauri::command]
pub async fn write_session_attachment(
    handle: AppHandle,
    session_id: String,
    message_timestamp: String,
    filename: String,
    data_base64: String,
) -> AppResult<WrittenAttachment> {
    use base64::Engine;
    let dir = session_dir(&handle, &session_id).await?;
    let clean_name = sanitize_attachment_name(&filename)?;
    // message_timestamp is used as a filename prefix. Constrain to digits only
    // (frontend uses Date.now()) to keep paths predictable and safe.
    if message_timestamp.is_empty()
        || !message_timestamp.chars().all(|c| c.is_ascii_digit())
        || message_timestamp.len() > 32
    {
        return Err(AppError::validation("Invalid message timestamp"));
    }

    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes())?;

    let final_path = unique_attachment_path(&dir, &message_timestamp, &clean_name);
    if !final_path.starts_with(&dir) {
        return Err(AppError::validation("Invalid attachment path"));
    }

    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = final_path.with_extension(format!("tmp.{}.{}", std::process::id(), suffix));
    tokio::fs::write(&tmp_path, &bytes).await?;
    tokio::fs::rename(&tmp_path, &final_path).await?;

    let out_name = final_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&clean_name)
        .to_string();
    Ok(WrittenAttachment {
        path: final_path.to_string_lossy().to_string(),
        filename: out_name,
    })
}

/// Read an attachment file from disk and return it base64-encoded. Path must
/// resolve under `~/.tomat/sessions/`.
#[tauri::command]
pub async fn read_session_attachment(handle: AppHandle, path: String) -> AppResult<String> {
    use base64::Engine;
    let home = handle.path().home_dir()?;
    let sessions_root = home.join(".tomat").join("sessions").canonicalize()?;
    let requested = PathBuf::from(&path);
    let canonical = resolve_within(&requested, &sessions_root)
        .ok_or_else(|| AppError::validation(format!("Path not under ~/.tomat/sessions: {path}")))?;
    let bytes = tokio::fs::read(&canonical).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Best-effort delete of attachment files under `~/.tomat/sessions/`. Missing
/// paths are silently ignored so callers can use this as cleanup after edits.
#[tauri::command]
pub async fn delete_session_attachments(handle: AppHandle, paths: Vec<String>) -> AppResult<()> {
    let home = handle.path().home_dir()?;
    let sessions_root = home.join(".tomat").join("sessions");
    let sessions_root_canonical = match sessions_root.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };

    for path_str in paths {
        let p = PathBuf::from(&path_str);
        if let Some(canonical) = resolve_within(&p, &sessions_root_canonical) {
            if canonical.is_file() {
                let _ = tokio::fs::remove_file(&canonical).await;
            }
        }
    }
    Ok(())
}
