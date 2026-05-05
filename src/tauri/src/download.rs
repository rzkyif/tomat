//! Centralized download manager.
//!
//! Owns a queue of `DownloadItem`s, a concurrency semaphore, and the side
//! channel of `download-queue` events the frontend listens to. Both the UI
//! (via `enqueue_downloads`) and the sidecars (via `ensure`) feed downloads
//! through here, so a single chip + modal in the Settings sidebar can show
//! the full state.
//!
//! Persistence: the queue is mirrored to `~/.tomat/downloads.json` on every
//! state change so completed / errored / cancelled rows survive an app
//! restart, and any `Pending` / `Downloading` items resume on the next
//! launch (re-fetched from zero; no partial-file resume).

use crate::error::{AppError, AppResult};
use crate::state::MAX_CONCURRENT_DOWNLOADS;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{broadcast, Semaphore};

/// Held while the download permit is still owned, before the next queued
/// item can acquire it. Avoids tripping HuggingFace's per-IP burst limits
/// when several files are queued back to back.
const INTER_DOWNLOAD_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum DownloadDestination {
    Models,
}

impl DownloadDestination {
    fn subdir(self) -> &'static str {
        match self {
            DownloadDestination::Models => "models",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub source: String,
    pub destination: DownloadDestination,
    pub rel_path: String,
    pub abs_path: String,
    pub filename: String,
    pub group_id: String,
    pub size_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub status: DownloadStatus,
    pub error: Option<String>,
    pub seen: bool,
    pub added_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnqueueSpec {
    pub source: String,
    pub destination: DownloadDestination,
    pub group_id: String,
    pub size_hint: Option<u64>,
}

struct DownloadHandle {
    cancelled: Arc<AtomicBool>,
    /// Final result broadcast to all waiters when the download task finishes.
    /// `Ok(abs_path)` on success, `Err(message)` on cancel or failure.
    completion: broadcast::Sender<Result<String, String>>,
}

pub struct DownloadManager {
    items: Mutex<Vec<DownloadItem>>,
    in_flight: Mutex<HashMap<String, DownloadHandle>>,
    sem: Arc<Semaphore>,
    persist_path: PathBuf,
}

impl DownloadManager {
    /// Construct the manager and load any persisted queue from
    /// `~/.tomat/downloads.json`. Items in active states get reset to
    /// `Pending`; call [`Self::start_resume`] once an `AppHandle` is available
    /// to actually re-spawn them.
    ///
    /// Self-heal pass: any persisted `Completed` row whose underlying
    /// file is no longer on disk gets dropped entirely. Otherwise a
    /// user-deleted file would leave a stale "Completed" entry that
    /// hides the missing-file UX cue and offers a Reveal action that
    /// would 404. Dropping it lets the next probe correctly identify
    /// the path as missing and surface the standard download flow.
    pub fn new(home: PathBuf) -> Arc<Self> {
        let persist_path = home.join(".tomat").join("downloads.json");

        let items = match std::fs::read(&persist_path) {
            Ok(bytes) => serde_json::from_slice::<Vec<DownloadItem>>(&bytes).unwrap_or_default(),
            Err(_) => Vec::new(),
        };

        let normalized: Vec<DownloadItem> = items
            .into_iter()
            .filter_map(|mut i| {
                // Drop persisted Completed rows whose file vanished.
                if matches!(i.status, DownloadStatus::Completed)
                    && !std::path::Path::new(&i.abs_path).exists()
                {
                    return None;
                }
                // Active items become Pending so the resume loop can
                // restart them. The .tmp file (if any) is overwritten
                // when the new stream starts.
                if matches!(i.status, DownloadStatus::Downloading) {
                    i.status = DownloadStatus::Pending;
                    i.downloaded_bytes = 0;
                }
                Some(i)
            })
            .collect();

        let manager = Arc::new(Self {
            items: Mutex::new(normalized),
            in_flight: Mutex::new(HashMap::new()),
            sem: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
            persist_path,
        });

        // Persist the cleaned snapshot so the on-disk file matches
        // even if the app exits before any further events fire.
        let snap = manager.snapshot();
        let _ = manager.persist(&snap);

        manager
    }

    /// Spawn `ensure()` for every persisted `Pending` item so resumed
    /// downloads kick off without waiting for the UI to re-trigger them.
    pub fn start_resume<R: Runtime>(self: &Arc<Self>, handle: &AppHandle<R>) {
        let pending: Vec<EnqueueSpec> = match self.items.lock() {
            Ok(items) => items
                .iter()
                .filter(|i| matches!(i.status, DownloadStatus::Pending))
                .map(|i| EnqueueSpec {
                    source: i.source.clone(),
                    destination: i.destination,
                    group_id: i.group_id.clone(),
                    size_hint: i.size_bytes,
                })
                .collect(),
            Err(_) => return,
        };

        let me = self.clone();
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            for spec in pending {
                let _ = me.ensure(&handle, spec).await;
            }
        });
    }

    /// Add (or join) a download for `spec`. If the file is already on disk,
    /// returns its path immediately. Otherwise the download is run in a
    /// background task and the call awaits its completion.
    pub async fn ensure<R: Runtime>(
        self: &Arc<Self>,
        handle: &AppHandle<R>,
        spec: EnqueueSpec,
    ) -> AppResult<PathBuf> {
        let abs_path = self.resolve_abs_path(handle, &spec)?;
        let id = compute_id(spec.destination, &abs_path);

        // Fast path: file already present on disk.
        if abs_path.exists() {
            self.upsert_completed(&id, &spec, &abs_path);
            self.emit_and_persist(handle);
            return Ok(abs_path);
        }

        // Subscribe / start.
        let (mut rx, just_started) = {
            let mut in_flight = self.lock_in_flight()?;
            if let Some(h) = in_flight.get(&id) {
                (h.completion.subscribe(), false)
            } else {
                let cancelled = Arc::new(AtomicBool::new(false));
                let (tx, rx) = broadcast::channel(1);
                in_flight.insert(
                    id.clone(),
                    DownloadHandle {
                        cancelled: cancelled.clone(),
                        completion: tx,
                    },
                );
                (rx, true)
            }
        };

        if just_started {
            self.upsert_pending(&id, &spec, &abs_path);
            self.emit_and_persist(handle);
            self.spawn_download(handle, id.clone(), spec, abs_path);
        }

        match rx.recv().await {
            Ok(Ok(path)) => Ok(PathBuf::from(path)),
            Ok(Err(msg)) => Err(AppError::external(msg)),
            Err(e) => Err(AppError::external(format!("download channel: {e}"))),
        }
    }

    pub fn snapshot(&self) -> Vec<DownloadItem> {
        self.items.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// Mark every item `seen = true`. Called when the user opens the modal.
    pub fn mark_all_seen<R: Runtime>(&self, handle: &AppHandle<R>) {
        if let Ok(mut items) = self.items.lock() {
            for i in items.iter_mut() {
                i.seen = true;
            }
        }
        self.emit_and_persist(handle);
    }

    /// Cancel an in-flight or queued download. Active downloads see the
    /// cancellation flag on their next chunk and clean up the .tmp file.
    pub fn cancel<R: Runtime>(&self, handle: &AppHandle<R>, id: &str) {
        // Signal the running task; it will transition the item to Cancelled
        // and emit. If nothing is in flight (Pending never got picked up,
        // already errored, etc.) flip the item directly here.
        let was_in_flight = {
            let in_flight = match self.lock_in_flight() {
                Ok(g) => g,
                Err(_) => return,
            };
            if let Some(h) = in_flight.get(id) {
                h.cancelled.store(true, Ordering::Release);
                true
            } else {
                false
            }
        };

        if !was_in_flight {
            if let Ok(mut items) = self.items.lock() {
                if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                    item.status = DownloadStatus::Cancelled;
                    item.error = None;
                }
            }
            self.emit_and_persist(handle);
        }
    }

    /// Re-enqueue an errored or cancelled download.
    pub fn retry<R: Runtime>(self: &Arc<Self>, handle: &AppHandle<R>, id: &str) {
        let spec = {
            let items = match self.items.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let Some(item) = items.iter().find(|i| i.id == id) else {
                return;
            };
            EnqueueSpec {
                source: item.source.clone(),
                destination: item.destination,
                group_id: item.group_id.clone(),
                size_hint: item.size_bytes,
            }
        };

        let me = self.clone();
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            let _ = me.ensure(&handle, spec).await;
        });
    }

    /// Drop a single item from the list. Files on disk are not touched.
    pub fn remove<R: Runtime>(&self, handle: &AppHandle<R>, id: &str) {
        if let Ok(mut items) = self.items.lock() {
            items.retain(|i| i.id != id);
        }
        self.emit_and_persist(handle);
    }

    /// Drop all `Completed` items from the list. Files on disk are not touched.
    pub fn clear_completed<R: Runtime>(&self, handle: &AppHandle<R>) {
        if let Ok(mut items) = self.items.lock() {
            items.retain(|i| !matches!(i.status, DownloadStatus::Completed));
        }
        self.emit_and_persist(handle);
    }

    // --- internal helpers -------------------------------------------------

    fn lock_in_flight(
        &self,
    ) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, DownloadHandle>>> {
        self.in_flight
            .lock()
            .map_err(|e| AppError::external(format!("download in_flight mutex poisoned: {e}")))
    }

    fn resolve_abs_path<R: Runtime>(
        &self,
        handle: &AppHandle<R>,
        spec: &EnqueueSpec,
    ) -> AppResult<PathBuf> {
        let root = destination_root(handle, spec.destination)?;
        let (rel_path, _url) = parse_source(&spec.source)?;
        Ok(root.join(rel_path))
    }

    fn upsert_pending(&self, id: &str, spec: &EnqueueSpec, abs_path: &std::path::Path) {
        if let Ok(mut items) = self.items.lock() {
            if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                item.status = DownloadStatus::Pending;
                item.error = None;
                item.downloaded_bytes = 0;
                if let Some(sz) = spec.size_hint {
                    item.size_bytes = Some(sz);
                }
                return;
            }
            let (rel_path, _) = parse_source(&spec.source).unwrap_or_default();
            let filename = std::path::Path::new(&rel_path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.clone());
            items.push(DownloadItem {
                id: id.to_string(),
                source: spec.source.clone(),
                destination: spec.destination,
                rel_path,
                abs_path: abs_path.to_string_lossy().to_string(),
                filename,
                group_id: spec.group_id.clone(),
                size_bytes: spec.size_hint,
                downloaded_bytes: 0,
                status: DownloadStatus::Pending,
                error: None,
                seen: true, // seen by definition: user just enqueued it
                added_at_ms: now_ms(),
            });
        }
    }

    fn upsert_completed(&self, id: &str, spec: &EnqueueSpec, abs_path: &std::path::Path) {
        if let Ok(mut items) = self.items.lock() {
            if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                item.status = DownloadStatus::Completed;
                item.error = None;
                item.downloaded_bytes = item.size_bytes.unwrap_or(item.downloaded_bytes);
                item.abs_path = abs_path.to_string_lossy().to_string();
                return;
            }
            // File already existed without being tracked: surface a Completed
            // row so the user can still reveal it in the modal.
            let (rel_path, _) = parse_source(&spec.source).unwrap_or_default();
            let filename = std::path::Path::new(&rel_path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.clone());
            let size = std::fs::metadata(abs_path).ok().map(|m| m.len());
            items.push(DownloadItem {
                id: id.to_string(),
                source: spec.source.clone(),
                destination: spec.destination,
                rel_path,
                abs_path: abs_path.to_string_lossy().to_string(),
                filename,
                group_id: spec.group_id.clone(),
                size_bytes: size,
                downloaded_bytes: size.unwrap_or(0),
                status: DownloadStatus::Completed,
                error: None,
                seen: true,
                added_at_ms: now_ms(),
            });
        }
    }

    fn set_status<R: Runtime>(
        &self,
        handle: &AppHandle<R>,
        id: &str,
        update: impl FnOnce(&mut DownloadItem),
    ) {
        if let Ok(mut items) = self.items.lock() {
            if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                update(item);
            }
        }
        self.emit_and_persist(handle);
    }

    /// Mark this download as failed with `msg`, return the matching `AppError`.
    /// Lets every error path in `run_download_inner` collapse to a single line.
    fn fail<R: Runtime>(&self, handle: &AppHandle<R>, id: &str, msg: String) -> AppError {
        self.set_status(handle, id, |item| {
            item.status = DownloadStatus::Error;
            item.error = Some(msg.clone());
        });
        AppError::external(msg)
    }

    fn emit_and_persist<R: Runtime>(&self, handle: &AppHandle<R>) {
        let snap = self.snapshot();
        let _ = handle.emit("download-queue", &snap);
        let _ = self.persist(&snap);
    }

    fn persist(&self, snap: &[DownloadItem]) -> AppResult<()> {
        if let Some(parent) = self.persist_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(snap)?;
        let tmp = self.persist_path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(tmp, &self.persist_path)?;
        Ok(())
    }

    fn spawn_download<R: Runtime>(
        self: &Arc<Self>,
        handle: &AppHandle<R>,
        id: String,
        spec: EnqueueSpec,
        abs_path: PathBuf,
    ) {
        let me = self.clone();
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            let result = me.run_download(&handle, &id, &spec, &abs_path).await;

            let result_for_broadcast: Result<String, String> = match &result {
                Ok(p) => Ok(p.to_string_lossy().to_string()),
                Err(e) => Err(e.to_string()),
            };

            // Drop the in-flight handle and broadcast the final outcome to
            // any awaiters. Handle is removed before broadcasting so a new
            // ensure() right after will start a fresh attempt.
            let sender = {
                let mut in_flight = match me.in_flight.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        eprintln!("[download] in_flight mutex poisoned: {e}");
                        return;
                    }
                };
                in_flight.remove(&id).map(|h| h.completion)
            };
            if let Some(sender) = sender {
                let _ = sender.send(result_for_broadcast);
            }
        });
    }

    async fn run_download<R: Runtime>(
        &self,
        handle: &AppHandle<R>,
        id: &str,
        spec: &EnqueueSpec,
        abs_path: &std::path::Path,
    ) -> AppResult<PathBuf> {
        let cancelled = match self.lock_in_flight()?.get(id) {
            Some(h) => h.cancelled.clone(),
            None => return Err(AppError::external("download handle missing")),
        };

        let _permit = self.sem.clone().acquire_owned().await?;

        // Wrap the actual transfer so every exit path goes through the
        // post-transfer throttle below (1s while the permit is still held)
        // before the next queued download can acquire it.
        let result = self
            .run_download_inner(handle, id, spec, abs_path, &cancelled)
            .await;

        // Inter-download throttle. Only meaningful if there's another item
        // already waiting; otherwise the drop just delays an idle release.
        // Skipped on the file-already-existed fast path which short-circuits
        // before any network work and doesn't need the cooldown.
        if !matches!(&result, Ok(p) if p == abs_path && self.was_existing_short_circuit(id)) {
            tokio::time::sleep(INTER_DOWNLOAD_DELAY).await;
        }

        result
    }

    /// True if the row reached `Completed` without any bytes being
    /// transferred (i.e. the file already existed on disk when this
    /// task picked it up). Used to skip the post-download cooldown for
    /// these no-op completions so a queue full of cached files doesn't
    /// pay the throttle penalty for nothing.
    fn was_existing_short_circuit(&self, id: &str) -> bool {
        self.items
            .lock()
            .ok()
            .and_then(|items| {
                items
                    .iter()
                    .find(|i| i.id == id)
                    .map(|i| i.downloaded_bytes == 0 && i.status == DownloadStatus::Completed)
            })
            .unwrap_or(false)
    }

    async fn run_download_inner<R: Runtime>(
        &self,
        handle: &AppHandle<R>,
        id: &str,
        spec: &EnqueueSpec,
        abs_path: &std::path::Path,
        cancelled: &Arc<AtomicBool>,
    ) -> AppResult<PathBuf> {
        if cancelled.load(Ordering::Acquire) {
            self.set_status(handle, id, |item| {
                item.status = DownloadStatus::Cancelled;
            });
            return Err(AppError::external("Download cancelled"));
        }

        // Re-check existence after acquiring the semaphore: a peer task may
        // have written the file while we were queued.
        if abs_path.exists() {
            self.set_status(handle, id, |item| {
                item.status = DownloadStatus::Completed;
                item.error = None;
                if let Some(sz) = item.size_bytes {
                    item.downloaded_bytes = sz;
                }
            });
            return Ok(abs_path.to_path_buf());
        }

        if let Some(parent) = abs_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let (_rel, url) = parse_source(&spec.source)?;
        if url.is_empty() {
            return Err(self.fail(handle, id, "Source is not a downloadable URL".to_string()));
        }

        let client = reqwest::Client::new();
        let res = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return Err(self.fail(handle, id, format!("Request failed: {e}"))),
        };

        if !res.status().is_success() {
            return Err(self.fail(handle, id, format!("Server returned {}", res.status())));
        }

        let total_size = res.content_length();
        self.set_status(handle, id, |item| {
            item.status = DownloadStatus::Downloading;
            item.error = None;
            item.downloaded_bytes = 0;
            if let Some(sz) = total_size {
                item.size_bytes = Some(sz);
            }
        });

        let mut stream = res.bytes_stream();
        let tmp_path = abs_path.with_extension("tmp");
        let mut file = tokio::fs::File::create(&tmp_path).await?;
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        let mut last_emit_pct: f64 = 0.0;

        while let Some(chunk_res) = stream.next().await {
            if cancelled.load(Ordering::Acquire) {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp_path).await;
                self.set_status(handle, id, |item| {
                    item.status = DownloadStatus::Cancelled;
                    item.error = None;
                });
                return Err(AppError::external("Download cancelled"));
            }

            let chunk = match chunk_res {
                Ok(c) => c,
                Err(e) => {
                    drop(file);
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(self.fail(handle, id, format!("Stream error: {e}")));
                }
            };
            tokio::io::copy(&mut &chunk[..], &mut file).await?;
            downloaded += chunk.len() as u64;

            // Throttle: emit on >=1% delta or >=500ms.
            let pct = total_size
                .map(|t| {
                    if t > 0 {
                        (downloaded as f64 / t as f64) * 100.0
                    } else {
                        0.0
                    }
                })
                .unwrap_or(0.0);
            let now = std::time::Instant::now();
            if (pct - last_emit_pct).abs() >= 1.0
                || now.duration_since(last_emit).as_millis() >= 500
            {
                last_emit_pct = pct;
                last_emit = now;
                self.set_status(handle, id, |item| {
                    item.downloaded_bytes = downloaded;
                });
            }
        }

        drop(file);
        tokio::fs::rename(&tmp_path, abs_path).await?;

        self.set_status(handle, id, |item| {
            item.status = DownloadStatus::Completed;
            item.error = None;
            item.downloaded_bytes = downloaded;
            if total_size.is_none() {
                item.size_bytes = Some(downloaded);
            }
            item.seen = false;
            item.abs_path = abs_path.to_string_lossy().to_string();
        });

        Ok(abs_path.to_path_buf())
    }
}

// --- module helpers -------------------------------------------------------

fn compute_id(dest: DownloadDestination, abs_path: &std::path::Path) -> String {
    format!("{}:{}", dest.subdir(), abs_path.to_string_lossy())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn destination_root<R: Runtime>(
    handle: &AppHandle<R>,
    dest: DownloadDestination,
) -> AppResult<PathBuf> {
    let home = handle.path().home_dir()?;
    Ok(home.join(".tomat").join(dest.subdir()))
}

/// Parse a download source string into `(rel_path, url)`.
///
/// Supports the existing HuggingFace path syntax `@user/repo/branch/filename`,
/// where the relative path under the destination root is `user/repo/filename`
/// and the URL points at the HF resolve endpoint.
fn parse_source(source: &str) -> AppResult<(String, String)> {
    if !source.starts_with('@') {
        // Absolute path: not downloadable, only a file-existence check.
        return Ok((source.to_string(), String::new()));
    }
    let parts: Vec<&str> = source[1..].split('/').collect();
    if parts.len() < 4 {
        return Err(AppError::validation("Invalid source path format"));
    }
    let username = parts[0];
    let reponame = parts[1];
    let branchname = parts[2];
    let filename = parts[3..].join("/");
    let rel = format!("{username}/{reponame}/{filename}");
    let url = format!(
        "https://huggingface.co/{username}/{reponame}/resolve/{branchname}/{filename}?download=true"
    );
    Ok((rel, url))
}

// --- probe (preview sizes for ConfirmModal) -------------------------------

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
) -> AppResult<DownloadPlan> {
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

    let (rel_path, url) = parse_source(path)?;
    let filename = std::path::Path::new(&rel_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_path.clone());

    let dest_path = destination_root(handle, DownloadDestination::Models)?.join(&rel_path);
    if dest_path.exists() {
        return Ok(DownloadPlan {
            path: path.to_string(),
            url: String::new(),
            filename,
            size_bytes: None,
            already_downloaded: true,
        });
    }

    // HF resolve URLs 302-redirect to a CDN that often omits Content-Length on
    // HEAD. The 302 itself carries the size in `x-linked-size`, so probe
    // without following redirects first and fall back to a normal HEAD.
    let no_redirect = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
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

// --- Tauri commands -------------------------------------------------------

#[tauri::command]
pub async fn probe_downloads(
    handle: AppHandle,
    paths: Vec<String>,
) -> AppResult<Vec<DownloadPlan>> {
    let futures = paths.iter().map(|p| probe_download(&handle, p));
    let results = futures_util::future::join_all(futures).await;
    let mut out = Vec::with_capacity(results.len());
    for r in results {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn enqueue_downloads(
    handle: AppHandle,
    state: State<'_, crate::state::AppState>,
    items: Vec<EnqueueSpec>,
) -> AppResult<()> {
    for spec in items {
        let manager = state.0.downloads.clone();
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            let _ = manager.ensure(&handle, spec).await;
        });
    }
    Ok(())
}

#[tauri::command]
pub fn download_state(state: State<'_, crate::state::AppState>) -> AppResult<Vec<DownloadItem>> {
    Ok(state.0.downloads.snapshot())
}

#[tauri::command]
pub fn cancel_download(
    handle: AppHandle,
    state: State<'_, crate::state::AppState>,
    id: String,
) -> AppResult<()> {
    state.0.downloads.cancel(&handle, &id);
    Ok(())
}

#[tauri::command]
pub fn retry_download(
    handle: AppHandle,
    state: State<'_, crate::state::AppState>,
    id: String,
) -> AppResult<()> {
    state.0.downloads.retry(&handle, &id);
    Ok(())
}

#[tauri::command]
pub fn remove_download(
    handle: AppHandle,
    state: State<'_, crate::state::AppState>,
    id: String,
) -> AppResult<()> {
    state.0.downloads.remove(&handle, &id);
    Ok(())
}

#[tauri::command]
pub fn clear_completed_downloads(
    handle: AppHandle,
    state: State<'_, crate::state::AppState>,
) -> AppResult<()> {
    state.0.downloads.clear_completed(&handle);
    Ok(())
}

#[tauri::command]
pub fn mark_downloads_seen(
    handle: AppHandle,
    state: State<'_, crate::state::AppState>,
) -> AppResult<()> {
    state.0.downloads.mark_all_seen(&handle);
    Ok(())
}
