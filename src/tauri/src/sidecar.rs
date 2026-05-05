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

use crate::download::{DownloadDestination, EnqueueSpec};
use crate::error::{AppError, AppResult};
use crate::sidecar_kind::SidecarKind;
use crate::state::{AppState, Sidecar};
use crate::types::{ServerStatus, ServerStatusUpdate};
#[cfg(not(target_os = "windows"))]
use crate::utils::current_target_triple;
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
// Windows Job Object: kill-on-close
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

    // No auto-fetch happens here. Every download (sidecar models, TTS
    // assets, toolkit embedding model, etc.) is gated on explicit user
    // confirmation via the Settings ConfirmModal flow. The bun sidecar
    // just runs; if the embedding files happen to be missing, the
    // /api/embed endpoint reports the gap and toolkit relevance is
    // disabled until the user confirms a download.
    result
}

/// Resolve a single optional model spec. `None` / empty maps to `Ok(None)`;
/// non-empty specs are routed through the download manager.
///
/// On error: emits an `Error` status and returns `Err(())` if this start is
/// still current; if it's been superseded, returns `Err(())` without emitting
/// (so the new start owns the status). Either way the caller bails.
async fn resolve_optional_path<R: Runtime>(
    handle: &AppHandle<R>,
    state: &AppState,
    server: &str,
    start_id: u64,
    spec: Option<String>,
) -> Result<Option<String>, ()> {
    let Some(s) = spec else { return Ok(None) };
    if s.is_empty() {
        return Ok(None);
    }
    match resolve_path_via_downloader(handle, state, server, &s).await {
        Ok(path) => Ok(Some(path)),
        Err(_) if !is_current_start(state, server, start_id) => Err(()),
        Err(e) => {
            emit_status(
                handle,
                server,
                ServerStatus::Error,
                None,
                Some(e.to_string()),
            )
            .await;
            Err(())
        }
    }
}

/// Replace `__MODEL_PATH__` / `__MMPROJ_PATH__` tokens in the argument vector
/// with the resolved on-disk paths. `--mmproj` is dropped when no mmproj path
/// was provided so the sidecar doesn't see a flag with no value.
fn substitute_path_tokens(
    args: Vec<String>,
    model_path: Option<&str>,
    mmproj_path: Option<&str>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    for a in args {
        if a == "__MODEL_PATH__" {
            out.push(model_path.unwrap_or("").to_string());
        } else if a == "__MMPROJ_PATH__" {
            if let Some(p) = mmproj_path {
                out.push(p.to_string());
            }
        } else if a == "--mmproj" && mmproj_path.is_none() {
            continue;
        } else {
            out.push(a);
        }
    }
    out
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
        let Ok(actual_model_path) = resolve_optional_path(
            &handle_clone,
            &state_clone,
            &server_clone,
            current_start_id,
            model_path,
        )
        .await
        else {
            return;
        };

        let Ok(actual_mmproj_path) = resolve_optional_path(
            &handle_clone,
            &state_clone,
            &server_clone,
            current_start_id,
            mmproj_path,
        )
        .await
        else {
            return;
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

        let final_args = substitute_path_tokens(
            args,
            actual_model_path.as_deref(),
            actual_mmproj_path.as_deref(),
        );

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

/// Resolve the on-disk path for a model spec, downloading if necessary via
/// the centralized `DownloadManager`. Bare local paths are validated; HF
/// `@user/repo/branch/file` specs are routed through the manager so progress
/// surfaces in the global Downloads modal rather than the per-server chip.
async fn resolve_path_via_downloader<R: Runtime>(
    handle: &AppHandle<R>,
    state: &AppState,
    server: &str,
    spec: &str,
) -> AppResult<String> {
    if !spec.starts_with('@') {
        let path = std::path::Path::new(spec);
        if path.exists() {
            return Ok(spec.to_string());
        }
        return Err(AppError::not_found(format!(
            "Model path does not exist: {spec}"
        )));
    }

    emit_status(
        handle,
        server,
        ServerStatus::Loading,
        None,
        Some("Waiting for downloads...".into()),
    )
    .await;

    let group_id = match SidecarKind::from_str(server) {
        Ok(SidecarKind::Llm) => "llm",
        Ok(SidecarKind::Stt) => "stt",
        // The bun sidecar handles toolkit assets (embedding model, TTS),
        // grouped under "toolkits" / "tts" respectively. We default to
        // "toolkits" here; TTS callers go through `ensure` directly with
        // their own group_id.
        _ => "toolkits",
    };

    let enqueue = EnqueueSpec {
        source: spec.to_string(),
        destination: DownloadDestination::Models,
        group_id: group_id.to_string(),
        size_hint: None,
    };
    let path = state.0.downloads.ensure(handle, enqueue).await?;
    Ok(path.to_string_lossy().to_string())
}
