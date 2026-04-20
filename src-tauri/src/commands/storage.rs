//! Storage UI: enumerate and clear `~/.tomat/` content.
//!
//! The tree builders walk directories synchronously because issuing a
//! tokio task per file is heavier than the blocking read cost on the
//! typical working set; this keeps the storage view snappy without async
//! overhead on what is effectively a stat-heavy traversal.

use crate::commands::paths::resolve_within;
use crate::commands::session::{read_session_file_sync, SessionFile};
use crate::commands::settings::clear_secrets;
use crate::commands::snippets::Snippet;
use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

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
    pub snippets: Vec<StorageNode>,
    pub total_size: u64,
    pub models_size: u64,
    pub sessions_size: u64,
    pub snippets_size: u64,
    pub settings_size: u64,
    pub root_path: String,
}

fn dir_size_recursive(path: &Path) -> u64 {
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

// File extensions that count as "model / support files" we want to surface
// in the storage UI. Includes gguf (llama.cpp), bin (whisper.cpp + some ORT
// voice tensors), onnx + json (Kokoro / transformers.js), and pt (PyTorch
// weight tensors, used by Kokoro-style voice files).
const MODEL_FILE_EXTS: &[&str] = &["gguf", "bin", "onnx", "json", "pt"];

fn collect_model_files(base: &Path, dir: &Path, out: &mut Vec<StorageNode>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_model_files(base, &p, out);
        } else if meta.is_file() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if !MODEL_FILE_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let rel = p.strip_prefix(base).unwrap_or(&p);
            let name = rel.to_string_lossy().to_string();
            out.push(StorageNode::File {
                name,
                path: p.to_string_lossy().to_string(),
                size: meta.len(),
            });
        }
    }
}

fn build_models_tree(models_dir: &Path) -> Vec<StorageNode> {
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
            let display_name = format!("{user_name}/{repo_name}");

            let mut files = Vec::new();
            collect_model_files(&repo_path, &repo_path, &mut files);
            files.sort_by(|a, b| storage_name(a).cmp(storage_name(b)));

            let has_mmproj = files.iter().any(|n| {
                let name = storage_name(n);
                let basename = name.rsplit('/').next().unwrap_or(name);
                basename.to_ascii_lowercase().starts_with("mmproj")
            });

            if files.is_empty() {
                continue;
            }

            if has_mmproj || files.len() > 1 {
                let size: u64 = files.iter().map(storage_size).sum();
                out.push(StorageNode::Folder {
                    name: display_name,
                    path: repo_path.to_string_lossy().to_string(),
                    size,
                    children: files,
                });
            } else {
                // Single-file repo: render inline "user/repo/filename" so the
                // list stays dense when only one file matters (e.g. whisper).
                let Some(file) = files.into_iter().next() else {
                    continue;
                };
                if let StorageNode::File {
                    name: fname,
                    path,
                    size,
                } = file
                {
                    out.push(StorageNode::File {
                        name: format!("{display_name}/{fname}"),
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

fn build_sessions_tree(sessions_dir: &Path) -> Vec<StorageNode> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let stem = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let messages_path = p.join("messages.json");
        if !messages_path.exists() {
            continue;
        }
        let title = read_session_file_sync(&messages_path)
            .map(|s: SessionFile| s.title)
            .unwrap_or_default();
        let display = if title.trim().is_empty() { stem } else { title };
        out.push(StorageNode::File {
            name: display,
            path: p.to_string_lossy().to_string(),
            size: dir_size_recursive(&p),
        });
    }
    out.sort_by(|a, b| storage_name(a).cmp(storage_name(b)));
    out
}

fn build_snippets_tree(snippets_dir: &Path) -> Vec<StorageNode> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(snippets_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        // Prefer the snippet's user-facing `name` field when readable; otherwise
        // fall back to the filename stem.
        let display = std::fs::read_to_string(&p)
            .ok()
            .and_then(|c| serde_json::from_str::<Snippet>(&c).ok())
            .map(|s| s.name)
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(stem);
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
pub async fn list_tomat_storage(handle: AppHandle) -> AppResult<StorageTree> {
    let home = handle.path().home_dir()?;
    let root = home.join(".tomat");
    let models_dir = root.join("models");
    let sessions_dir = root.join("sessions");
    let snippets_dir = root.join("snippets");

    let models = build_models_tree(&models_dir);
    let sessions = build_sessions_tree(&sessions_dir);
    let snippets = build_snippets_tree(&snippets_dir);

    let models_size: u64 = models.iter().map(storage_size).sum();
    let sessions_size: u64 = sessions.iter().map(storage_size).sum();
    let snippets_size: u64 = snippets.iter().map(storage_size).sum();
    let settings_size = std::fs::metadata(root.join("settings.json"))
        .map(|m| m.len())
        .unwrap_or(0);
    let total_size = dir_size_recursive(&root);

    Ok(StorageTree {
        models,
        sessions,
        snippets,
        total_size,
        models_size,
        sessions_size,
        snippets_size,
        settings_size,
        root_path: root.to_string_lossy().to_string(),
    })
}

/// Delete the given paths. Every path is canonicalized and must resolve under `~/.tomat/`.
#[tauri::command]
pub async fn delete_tomat_paths(handle: AppHandle, paths: Vec<String>) -> AppResult<()> {
    let home = handle.path().home_dir()?;
    let root_canonical = home.join(".tomat").canonicalize()?;

    for path_str in paths {
        let p = PathBuf::from(&path_str);
        let canonical = resolve_within(&p, &root_canonical)
            .ok_or_else(|| AppError::validation(format!("Path not under ~/.tomat: {path_str}")))?;
        let meta = tokio::fs::metadata(&canonical).await?;
        if meta.is_dir() {
            tokio::fs::remove_dir_all(&canonical).await?;
        } else {
            tokio::fs::remove_file(&canonical).await?;
        }
    }
    Ok(())
}

/// Remove all downloaded models from `~/.tomat/models/`.
#[tauri::command]
pub async fn clear_tomat_models(handle: AppHandle) -> AppResult<()> {
    let home = handle.path().home_dir()?;
    let dir = home.join(".tomat").join("models");
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    tokio::fs::create_dir_all(&dir).await?;
    Ok(())
}

/// Remove every saved session from `~/.tomat/sessions/`.
#[tauri::command]
pub async fn clear_tomat_sessions(handle: AppHandle) -> AppResult<()> {
    let home = handle.path().home_dir()?;
    let dir = home.join(".tomat").join("sessions");
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    tokio::fs::create_dir_all(&dir).await?;
    Ok(())
}

/// Wipe the settings file and every keychain entry (release) or the
/// `.secrets.json` fallback (dev) for the caller-named secrets.
#[tauri::command]
pub async fn clear_tomat_settings(handle: AppHandle, secret_keys: Vec<String>) -> AppResult<()> {
    let home = handle.path().home_dir()?;
    let path = home.join(".tomat").join("settings.json");
    if path.exists() {
        tokio::fs::remove_file(&path).await?;
    }
    clear_secrets(&handle, &secret_keys).await?;
    Ok(())
}
