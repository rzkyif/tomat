//! Sidecar control: status snapshot, model fetch, restart, and arg replacement.

use crate::download::{DownloadDestination, EnqueueSpec};
use crate::error::{AppError, AppResult};
use crate::sidecar::{emit_status, start_bun_sidecar, update_server_args_internal};
use crate::state::AppState;
use crate::types::ServerStatus;
use std::collections::HashMap;
use std::str::FromStr;
use tauri::{AppHandle, State};

/// Return a snapshot of each tracked sidecar's status. Used on startup
/// when the frontend reconciles against any already-running processes.
#[tauri::command]
pub async fn get_server_statuses(
    state: State<'_, AppState>,
) -> AppResult<HashMap<String, ServerStatus>> {
    let sidecars = state
        .0
        .sidecars
        .lock()
        .map_err(|e| AppError::sidecar(format!("sidecar mutex poisoned: {e}")))?;
    let mut statuses = HashMap::new();
    for (name, _) in sidecars.iter() {
        statuses.insert(name.clone(), ServerStatus::Running);
    }
    Ok(statuses)
}

/// Route the given Hugging Face paths through the centralized download
/// manager. Returns once every requested file is on disk. Used by callers
/// (e.g. the TTS toggle) that want one-shot fetches outside the sidecar
/// restart flow. Progress is surfaced in the global Downloads modal.
#[tauri::command]
pub async fn ensure_models(
    handle: AppHandle,
    state: State<'_, AppState>,
    server: String,
    paths: Vec<String>,
) -> AppResult<()> {
    let group_id = match crate::sidecar_kind::SidecarKind::from_str(&server) {
        Ok(crate::sidecar_kind::SidecarKind::Llm) => "llm",
        Ok(crate::sidecar_kind::SidecarKind::Stt) => "stt",
        _ => "toolkits",
    };

    let result = async {
        for path in &paths {
            let spec = EnqueueSpec {
                source: path.clone(),
                destination: DownloadDestination::Models,
                group_id: group_id.to_string(),
                size_hint: None,
            };
            state.0.downloads.ensure(&handle, spec).await?;
        }
        Ok::<(), AppError>(())
    }
    .await;

    match &result {
        Ok(_) => {
            emit_status(&handle, &server, ServerStatus::Running, None, None).await;
        }
        Err(e) => {
            emit_status(
                &handle,
                &server,
                ServerStatus::Error,
                None,
                Some(e.to_string()),
            )
            .await;
        }
    }

    result
}

/// Recycle the bun sidecar process. Used by the TTS toggle to free the ORT
/// session memory: in-process disposal works but the OS allocator keeps freed
/// pages mapped to the process, so RSS only visibly drops when the process
/// itself is replaced. The bun sidecar always stays running (it also hosts
/// upcoming tools), this just reincarnates it with a fresh heap.
#[tauri::command]
pub async fn restart_bun_sidecar(handle: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    start_bun_sidecar(handle, state.inner()).await
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
) -> AppResult<()> {
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
