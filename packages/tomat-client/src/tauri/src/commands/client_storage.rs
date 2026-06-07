//! On-disk storage view for the local client (the "Client → Storage" usage
//! field). Enumerates what the desktop app keeps under
//! `~/.tomat/<channel>/client/`: its settings file and rotated logs, with sizes.
//! Backup deletes and the settings reset are done frontend-side
//! (platform.fs.remove + clientSettings); the one write here is
//! `truncate_client_log`, which empties the active log without stopping logging.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
struct StorageNode {
    kind: &'static str, // always "file" for the client view
    name: String,
    path: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_reason: Option<String>,
}

#[derive(Serialize)]
struct StorageCategory {
    id: &'static str,
    label: &'static str,
    deletable: bool,
    nodes: Vec<StorageNode>,
    size: u64,
}

#[derive(Serialize)]
pub struct StorageTree {
    categories: Vec<StorageCategory>,
    total_size: u64,
    root_path: String,
}

fn client_root() -> AppResult<PathBuf> {
    let home = std::env::home_dir()
        .ok_or_else(|| AppError::external("could not determine home directory"))?;
    Ok(crate::channel::channel_root(&home).join("client"))
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// The client's on-disk storage tree (settings + logs), with sizes.
#[tauri::command]
pub fn get_client_storage() -> AppResult<StorageTree> {
    let root = client_root()?;

    // Settings: the single client settings.json. Cleared via a reset, not a file
    // delete (the frontend preserves paired cores + snippets), so it's never
    // locked but also not individually selectable in the UI.
    let settings_path = root.join("settings.json");
    let settings_size = file_size(&settings_path);
    let settings = StorageCategory {
        id: "settings",
        label: "Settings",
        deletable: true,
        size: settings_size,
        nodes: vec![StorageNode {
            kind: "file",
            name: "settings.json".to_string(),
            path: settings_path.to_string_lossy().to_string(),
            size: settings_size,
            lock_reason: None,
        }],
    };

    // Logs: every file under client/logs. All are clearable - the active
    // client.log is truncated (not removed) so logging continues; rotated
    // backups are removed. See truncate_client_log + the frontend provider.
    let logs_dir = root.join("logs");
    let mut log_nodes: Vec<StorageNode> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&logs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            log_nodes.push(StorageNode {
                kind: "file",
                size: file_size(&path),
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                lock_reason: None,
            });
        }
    }
    log_nodes.sort_by(|a, b| a.name.cmp(&b.name));
    let logs_size = log_nodes.iter().map(|n| n.size).sum();
    let logs = StorageCategory {
        id: "logs",
        label: "Logs",
        deletable: true,
        size: logs_size,
        nodes: log_nodes,
    };

    let total_size = settings_size + logs_size;
    Ok(StorageTree {
        categories: vec![settings, logs],
        total_size,
        root_path: root.to_string_lossy().to_string(),
    })
}

/// Empty the active client log in place. The logger (file_rotate) holds the file
/// open and appends, so truncating to length 0 reclaims the disk now and logging
/// continues from the start - whereas deleting the open file fails on Windows and
/// leaks the inode on Unix. Rotated backups are deleted by the frontend
/// (platform.fs.remove). No-op if the file doesn't exist.
#[tauri::command]
pub fn truncate_client_log() -> AppResult<()> {
    let path = client_root()?.join("logs").join("client.log");
    match std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::external(format!(
            "failed to truncate client log: {e}"
        ))),
    }
}
