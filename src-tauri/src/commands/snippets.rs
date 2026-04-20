//! Snippet CRUD. Snippets are user-defined text templates persisted as
//! JSON files under `~/.tomat/snippets/<id>.json`.

use crate::commands::paths::validate_snippet_id;
use crate::error::AppResult;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub trigger: String,
    pub placement: String,
    pub text: String,
}

pub(crate) async fn snippets_dir(handle: &AppHandle) -> AppResult<PathBuf> {
    let home = handle.path().home_dir()?;
    let dir = home.join(".tomat").join("snippets");
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

async fn snippet_file_path(handle: &AppHandle, id: &str) -> AppResult<PathBuf> {
    validate_snippet_id(id)?;
    Ok(snippets_dir(handle).await?.join(format!("{id}.json")))
}

/// Persist a single snippet to `~/.tomat/snippets/<id>.json` atomically.
#[tauri::command]
pub async fn save_snippet(handle: AppHandle, snippet: Snippet) -> AppResult<String> {
    let id = snippet.id.clone();
    let file_path = snippet_file_path(&handle, &id).await?;

    let content = serde_json::to_string_pretty(&snippet)?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = file_path.with_extension(format!("tmp.{}.{}", std::process::id(), suffix));
    tokio::fs::write(&tmp_path, content).await?;
    tokio::fs::rename(&tmp_path, &file_path).await?;
    Ok(id)
}

/// Read all snippets from `~/.tomat/snippets/`, sorted by name.
#[tauri::command]
pub async fn list_snippets(handle: AppHandle) -> AppResult<Vec<Snippet>> {
    let dir = snippets_dir(&handle).await?;
    let mut snippets: Vec<Snippet> = Vec::new();
    let mut reader = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = reader.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let content = match tokio::fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Ok(snippet) = serde_json::from_str::<Snippet>(&content) {
            snippets.push(snippet);
        }
    }
    snippets.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(snippets)
}

/// Remove a single snippet file.
#[tauri::command]
pub async fn delete_snippet(handle: AppHandle, id: String) -> AppResult<()> {
    let file_path = snippet_file_path(&handle, &id).await?;
    if !file_path.exists() {
        return Ok(());
    }
    tokio::fs::remove_file(&file_path).await?;
    Ok(())
}
