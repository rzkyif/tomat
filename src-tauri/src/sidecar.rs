//! Sidecar lifecycle: spawning, supersession, health checks, and model
//! download orchestration for the `llm`, `stt`, and `bun` processes.
//!
//! ## Secrets storage and `debug_assertions`
//!
//! Elsewhere in the crate (see `commands.rs`), the secrets flow branches on
//! `cfg(debug_assertions)` between the OS keychain and a plaintext fallback
//! file. That divergence is load-bearing: unsigned dev builds can't persist
//! keychain entries reliably across rebuilds (every rebuild changes the code
//! signature and the OS silently refuses reads of previously-written keys).
//! It has no effect on sidecar supervision here, but is called out so the two
//! code paths don't look mysterious on a cold read.

use crate::error::{AppError, AppResult};
use crate::sidecar_kind::SidecarKind;
use crate::state::{AppState, Sidecar};
use crate::types::{ServerStatus, ServerStatusUpdate};
#[cfg(not(target_os = "windows"))]
use crate::utils::current_target_triple;
use futures_util::StreamExt;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/// Grace period between SIGTERM and SIGKILL when superseding an old sidecar.
/// Unix-only: Windows has no SIGTERM equivalent and skips the grace period.
#[cfg(unix)]
const GRACEFUL_SHUTDOWN_SECS: u64 = 5;

/// Maximum number of health-check probes before giving up on a starting
/// sidecar. Combined with `HEALTH_CHECK_INTERVAL_SECS` this caps a slow
/// startup at 30s before the chip reports an error.
const HEALTH_CHECK_ATTEMPTS: u32 = 30;

/// Delay between consecutive health-check probes.
const HEALTH_CHECK_INTERVAL_SECS: u64 = 1;

/// When no health-check URL is provided, how long to wait after spawning
/// before declaring the sidecar Running. Tuned to exceed observed cold-start
/// times for llama-server / whisper-server.
const STARTUP_WARMUP_SECS: u64 = 2;

/// Maximum number of `-N` suffix attempts when finding a non-colliding
/// unique attachment path. Capped instead of `u32::MAX` so a pathological
/// directory can never lock a caller indefinitely.
pub const MAX_UNIQUE_SUFFIX_ATTEMPTS: u32 = 1_000;

// ---------------------------------------------------------------------------
// Windows Job Object — kill-on-close
//
// Sidecar processes spawned via tauri-plugin-shell on Windows are not in the
// parent's console group, so Ctrl+C does not propagate to them. A Job Object
// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE solves this at the OS level: when
// the last handle to the job closes (i.e. when this process exits for any
// reason), all member processes are automatically terminated.
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
mod job {
    use std::sync::OnceLock;

    type Handle = *mut core::ffi::c_void;
    type Dword = u32;
    type Bool = i32;

    // JOBOBJECT_BASIC_LIMIT_INFORMATION (64 bytes on 64-bit Windows).
    // Explicit _pad fields match the C struct's implicit alignment padding
    // after DWORD fields that precede SIZE_T / ULONG_PTR fields.
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInfo {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: Dword,
        _pad1: Dword,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: Dword,
        _pad2: Dword,
        affinity: usize,
        priority_class: Dword,
        scheduling_class: Dword,
    }

    // IO_COUNTERS (48 bytes).
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_op_count: u64,
        write_op_count: u64,
        other_op_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on 64-bit Windows).
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInfo {
        basic: BasicLimitInfo,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    extern "system" {
        fn CreateJobObjectW(lp_job_attributes: *mut u8, lp_name: *const u16) -> Handle;
        fn SetInformationJobObject(
            h_job: Handle,
            job_object_information_class: i32,
            lp_job_object_information: *const core::ffi::c_void,
            cb_job_object_information_length: Dword,
        ) -> Bool;
        fn OpenProcess(
            dw_desired_access: Dword,
            b_inherit_handle: Bool,
            dw_process_id: Dword,
        ) -> Handle;
        fn AssignProcessToJobObject(h_job: Handle, h_process: Handle) -> Bool;
        fn CloseHandle(h_object: Handle) -> Bool;
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const PROCESS_SET_QUOTA: Dword = 0x0100;
    const PROCESS_TERMINATE: Dword = 0x0001;

    struct JobHandle(Handle);
    // SAFETY: Win32 HANDLEs are kernel objects referenced by value. We never
    // alias this mutably; it is only used to assign new processes to the job.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<JobHandle> = OnceLock::new();

    pub fn init() {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                eprintln!("[sidecar] CreateJobObjectW failed");
                return;
            }
            let mut info = ExtendedLimitInfo::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<ExtendedLimitInfo>() as Dword,
            ) == 0
            {
                eprintln!("[sidecar] SetInformationJobObject failed");
            }
            let _ = JOB.set(JobHandle(job));
        }
    }

    pub fn assign(pid: u32) {
        let Some(job) = JOB.get() else { return };
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                eprintln!("[sidecar] OpenProcess({pid}) failed");
                return;
            }
            if AssignProcessToJobObject(job.0, process) == 0 {
                eprintln!("[sidecar] AssignProcessToJobObject({pid}) failed");
            }
            CloseHandle(process);
        }
    }
}

/// Called once at app startup. On Windows, creates the kill-on-close Job
/// Object so that all sidecars die automatically if the parent exits for any
/// reason, including crashes and Ctrl+C.
pub fn init_process_guards() {
    #[cfg(target_os = "windows")]
    job::init();
}

/// Synchronously kill every live sidecar. Called from the `RunEvent::Exit`
/// handler so sidecars are cleaned up on graceful exit on all platforms.
pub fn kill_all_sidecars(state: &AppState) {
    if let Ok(mut sidecars) = state.0.sidecars.lock() {
        for sidecar in sidecars.values_mut() {
            if let Some(child) = sidecar.child.take() {
                let _ = child.kill();
            }
        }
    }
}

pub fn shared_library_dir<R: Runtime>(handle: &AppHandle<R>, server: &str) -> AppResult<PathBuf> {
    let base = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries")
    } else {
        handle.path().resource_dir()?.join("binaries")
    };
    // Windows: each sidecar lives in its own subdirectory (binaries/llm/ or
    // binaries/stt/) with its own copy of ggml.dll and backend plugins.
    // ggml_backend_load_all() scans GetModuleFileNameW(NULL) (the exe dir) and
    // fs::current_path() for ggml-*.dll plugins. We set current_dir to this
    // subdirectory (in apply_runtime_library_path) so backends are reliably
    // found when spawned by a parent process. Keeping llama and whisper DLLs
    // separate also prevents their incompatible ggml versions from overwriting
    // each other.
    // Linux/macOS: DLLs live in a triple-specific subdirectory pointed at by
    // LD_LIBRARY_PATH / DYLD_LIBRARY_PATH; dlopen uses the explicit path so
    // there is no scan-by-directory conflict risk.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = server;
        let triple = current_target_triple().map_err(AppError::external)?;
        Ok(base.join(triple))
    }
    #[cfg(target_os = "windows")]
    {
        // Only llm/stt use platform library subdirs; bun and any other kind
        // resolve to the base binaries directory.
        match SidecarKind::from_str(server) {
            Ok(SidecarKind::Llm) => Ok(base.join(SidecarKind::Llm.as_str())),
            Ok(SidecarKind::Stt) => Ok(base.join(SidecarKind::Stt.as_str())),
            _ => Ok(base),
        }
    }
}

pub fn apply_runtime_library_path<R: Runtime>(
    handle: &AppHandle<R>,
    cmd: tauri_plugin_shell::process::Command,
    server: &str,
) -> AppResult<tauri_plugin_shell::process::Command> {
    let lib_dir = shared_library_dir(handle, server)?;
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
        // ggml_backend_load_all() scans both the exe directory and
        // fs::current_path(). Setting cwd to lib_dir ensures the scan finds
        // backends via current_path() even if exe-directory resolution differs
        // when launched by a parent process (e.g. Tauri sidecar mechanism).
        return Ok(cmd.env("PATH", value).current_dir(&lib_dir));
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
fn validate_health_check_url(url: &str) -> AppResult<()> {
    let parsed = url::Url::parse(url)?;
    if parsed.scheme() != "http" {
        return Err(AppError::validation(
            "Health check URL must use http scheme",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::validation("Health check URL missing host"))?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err(AppError::validation(
            "Health check URL must point to localhost",
        ));
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

/// Hugging Face paths for the MiniLM embedding model used by the toolkits
/// relevance filter. Kept in sync with EMBED_BASE_FILES in
/// src/lib/shared/settings.ts.
const EMBED_FILES: &[&str] = &[
    "@Xenova/all-MiniLM-L6-v2/main/config.json",
    "@Xenova/all-MiniLM-L6-v2/main/tokenizer.json",
    "@Xenova/all-MiniLM-L6-v2/main/tokenizer_config.json",
    "@Xenova/all-MiniLM-L6-v2/main/onnx/model_quantized.onnx",
];

/// Download the embedding model into `~/.tomat/models/` via the same
/// downloader used for llama / whisper / kokoro weights. Errors are surfaced
/// as a log line rather than blocking sidecar startup - the Bun sidecar
/// gates `/api/embed` on the files existing, so an incomplete download just
/// means phase-1 tool filtering is disabled until the download completes on
/// a later run.
async fn ensure_embedding_model<R: Runtime>(handle: &AppHandle<R>, state: &AppState) {
    for path in EMBED_FILES {
        if let Err(e) = ensure_path_internal(handle, state, "bun", path).await {
            eprintln!("[embedding] download {path} failed: {e}");
        }
    }
}

/// (Re)launch the bun tools sidecar with its canonical args. Used at startup
/// and on demand (e.g. when TTS is toggled off, to release the ORT session
/// memory by recycling the process - allocator behavior means in-process
/// disposal can't visibly reduce RSS).
pub async fn start_bun_sidecar<R: Runtime>(
    handle: AppHandle<R>,
    state: &AppState,
) -> AppResult<()> {
    let resources_path = handle.path().resource_dir()?;
    let server_js_path = resources_path.join("resources").join("server.js");
    let result = update_server_args_internal(
        handle.clone(),
        state,
        SidecarKind::Bun.as_str().to_string(),
        vec![
            // --smol favors a smaller heap and more aggressive GC at ~10%
            // throughput cost - the right trade for an idle-most-of-the-time
            // sidecar that bursts on big audio buffers.
            "--smol".to_string(),
            "run".to_string(),
            server_js_path.to_string_lossy().to_string(),
        ],
        None,
        None,
        Some("http://localhost:7703/api/health".to_string()),
    )
    .await;

    // Kick off the embedding-model fetch in the background so the first
    // toolkit-relevance pass doesn't pay the full download cost. The
    // download emits `sidecar-status` events on the "bun" channel, so the
    // existing UI surfaces progress without any new wiring.
    let handle_for_embed = handle.clone();
    let state_for_embed = state.clone();
    tauri::async_runtime::spawn(async move {
        ensure_embedding_model(&handle_for_embed, &state_for_embed).await;
        emit_status(&handle_for_embed, "bun", ServerStatus::Running, None, None).await;
    });

    result
}

pub async fn update_server_args_internal<R: Runtime>(
    handle: AppHandle<R>,
    state: &AppState,
    server: String,
    args: Vec<String>,
    model_path: Option<String>,
    mmproj_path: Option<String>,
    check_url: Option<String>,
) -> AppResult<()> {
    let (current_start_id, old_child, old_pid) = {
        let mut sidecars = state
            .0
            .sidecars
            .lock()
            .map_err(|e| AppError::sidecar(format!("sidecar mutex poisoned: {e}")))?;
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

    if args.is_empty() && server != SidecarKind::Bun.as_str() {
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
                            Some(e.to_string()),
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
                            Some(e.to_string()),
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

        let sidecar_name = match SidecarKind::from_str(&server_clone) {
            Ok(kind) => kind.binary_name(),
            Err(_) => {
                emit_status(
                    &handle_clone,
                    &server_clone,
                    ServerStatus::Error,
                    None,
                    Some(format!("unknown sidecar kind: {server_clone}")),
                )
                .await;
                return;
            }
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

        let cmd = match apply_runtime_library_path(&handle_clone, cmd, &server_clone) {
            Ok(cmd) => cmd,
            Err(e) => {
                emit_status(
                    &handle_clone,
                    &server_clone,
                    ServerStatus::Error,
                    None,
                    Some(e.to_string()),
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
                        let pid = child.pid();
                        s.pid = Some(pid);
                        s.child = Some(child);
                        #[cfg(target_os = "windows")]
                        job::assign(pid);
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
            // Reuse a single client across the polling loop so we don't pay
            // connection-pool setup cost on every probe.
            let client = match reqwest::Client::builder().build() {
                Ok(c) => c,
                Err(e) => {
                    emit_status(
                        &handle_clone,
                        &server_clone,
                        ServerStatus::Error,
                        None,
                        Some(format!("Failed to build health check client: {e}")),
                    )
                    .await;
                    return;
                }
            };

            let mut healthy = false;
            for _ in 0..HEALTH_CHECK_ATTEMPTS {
                if let Ok(res) = client.get(&url).send().await {
                    if res.status().is_success() {
                        healthy = true;
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS))
                    .await;

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
            tokio::time::sleep(std::time::Duration::from_secs(STARTUP_WARMUP_SECS)).await;
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
) -> AppResult<String> {
    if !model_path.starts_with('@') {
        let path = std::path::Path::new(model_path);
        if path.exists() {
            return Ok(model_path.to_string());
        } else {
            return Err(AppError::not_found(format!(
                "Model path does not exist: {model_path}"
            )));
        }
    }

    // @username/reponame/branchname/filename
    let parts: Vec<&str> = model_path[1..].split('/').collect();
    if parts.len() < 4 {
        return Err(AppError::validation("Invalid model path format"));
    }

    let username = parts[0];
    let reponame = parts[1];
    let branchname = parts[2];
    let filename = parts[3..].join("/");

    let home = handle.path().home_dir()?;
    let dest_dir = home
        .join(".tomat")
        .join("models")
        .join(username)
        .join(reponame);
    let dest_path = dest_dir.join(&filename);

    if dest_path.exists() {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    tokio::fs::create_dir_all(&dest_dir).await?;

    emit_status(
        handle,
        server,
        ServerStatus::Loading,
        None,
        Some("Waiting for download slot...".into()),
    )
    .await;

    let _download_guard = state.0.download_sem.acquire().await?;

    if !is_current_start(state, server, start_id) {
        return Err(AppError::external("Download cancelled"));
    }

    if dest_path.exists() {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    emit_status(
        handle,
        server,
        ServerStatus::Downloading,
        Some(0.0),
        Some(format!("Downloading {filename}...")),
    )
    .await;

    let url = format!(
        "https://huggingface.co/{username}/{reponame}/resolve/{branchname}/{filename}?download=true"
    );

    let client = reqwest::Client::new();
    let res = client.get(url).send().await?;

    if !res.status().is_success() {
        return Err(AppError::external(format!(
            "Failed to download model: {}",
            res.status()
        )));
    }

    let total_size = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    let tmp_path = dest_path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp_path).await?;

    while let Some(item) = stream.next().await {
        if !is_current_start(state, server, start_id) {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(AppError::external("Download cancelled"));
        }

        let chunk = item?;
        tokio::io::copy(&mut &chunk[..], &mut file).await?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;
            emit_status(
                handle,
                server,
                ServerStatus::Downloading,
                Some(progress),
                Some(format!(
                    "Downloading {filename} ({:.2} MB)...",
                    downloaded as f64 / 1024.0 / 1024.0
                )),
            )
            .await;
        }
    }

    tokio::fs::rename(tmp_path, &dest_path).await?;

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
) -> AppResult<String> {
    if !path.starts_with('@') {
        let p = std::path::Path::new(path);
        if p.exists() {
            return Ok(path.to_string());
        }
        return Err(AppError::not_found(format!("Path does not exist: {path}")));
    }

    let parts: Vec<&str> = path[1..].split('/').collect();
    if parts.len() < 4 {
        return Err(AppError::validation("Invalid model path format"));
    }
    let username = parts[0];
    let reponame = parts[1];
    let branchname = parts[2];
    let filename = parts[3..].join("/");

    let home = handle.path().home_dir()?;
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
        tokio::fs::create_dir_all(parent).await?;
    }

    emit_status(
        handle,
        server,
        ServerStatus::Loading,
        None,
        Some("Waiting for download slot...".into()),
    )
    .await;

    let _download_guard = state.0.download_sem.acquire().await?;

    if dest_path.exists() {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    emit_status(
        handle,
        server,
        ServerStatus::Downloading,
        Some(0.0),
        Some(format!("Downloading {filename}...")),
    )
    .await;

    let url = format!(
        "https://huggingface.co/{username}/{reponame}/resolve/{branchname}/{filename}?download=true"
    );

    let client = reqwest::Client::new();
    let res = client.get(url).send().await?;

    if !res.status().is_success() {
        return Err(AppError::external(format!(
            "Failed to download asset: {}",
            res.status()
        )));
    }

    let total_size = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    let tmp_path = dest_path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp_path).await?;

    while let Some(item) = stream.next().await {
        let chunk = item?;
        tokio::io::copy(&mut &chunk[..], &mut file).await?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;
            emit_status(
                handle,
                server,
                ServerStatus::Downloading,
                Some(progress),
                Some(format!(
                    "Downloading {filename} ({:.2} MB)...",
                    downloaded as f64 / 1024.0 / 1024.0
                )),
            )
            .await;
        }
    }

    tokio::fs::rename(tmp_path, &dest_path).await?;

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

    let parts: Vec<&str> = path[1..].split('/').collect();
    if parts.len() < 4 {
        return Err(AppError::validation("Invalid model path format"));
    }
    let username = parts[0];
    let reponame = parts[1];
    let branchname = parts[2];
    let filename = parts[3..].join("/");

    let home = handle.path().home_dir()?;
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
        "https://huggingface.co/{username}/{reponame}/resolve/{branchname}/{filename}?download=true"
    );

    // HF resolve URLs 302-redirect to a CDN that often omits Content-Length on
    // HEAD. The 302 response itself carries the LFS file size in
    // `x-linked-size`, so probe with redirects disabled first and fall back to
    // following redirects if HF didn't set it.
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
