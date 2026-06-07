//! Client logging: the `log` facade fed by two fern sinks.
//!
//!   - stdout: every level in dev, WARN+ in prod. Colored + formatted to match
//!     tomat-core's console formatter (lowercase padded level, optional dim
//!     module, then the message) so the multiplexed `deno task dev` console
//!     reads consistently across core and client.
//!   - file: WARN+ only, no color, ISO-8601 timestamp, appended to a single
//!     size-capped `~/.tomat/<channel>/client/logs/client.log` (rotated by
//!     `file-rotate`, keeping one backup).
//!
//! Frontend logs arrive via the `client_log` command and flow through the same
//! facade as native Rust `log::*!` calls, so everything shares one format and
//! one secret-scrubbing pass (mirrors core's `scrubSecrets`).

use std::io::{IsTerminal, Write};
use std::sync::LazyLock;

use file_rotate::{compression::Compression, suffix::AppendCount, ContentLimit, FileRotate};
use regex::Regex;

/// Initialize the global logger. Non-fatal: a logging-init failure must never
/// abort app boot, so it logs to stderr (still captured by the dev console) and
/// continues. Call once, as early as possible in `run()`.
pub fn init() {
    if let Err(e) = try_init() {
        eprintln!("[log] logger init failed (continuing without logging): {e}");
    }
}

fn try_init() -> Result<(), fern::InitError> {
    let is_dev = crate::channel::channel() == "dev";

    // Color/time env handling mirrors tomat-core/src/shared/log.ts. Our stdout is
    // piped to dev.ts (not a TTY), so color is driven by TOMAT_LOG_COLOR there;
    // TOMAT_LOG_NO_TIME lets dev.ts own the single timestamp column.
    let no_time = std::env::var("TOMAT_LOG_NO_TIME").as_deref() == Ok("1");
    let force_color = std::env::var("TOMAT_LOG_COLOR").as_deref() == Ok("1");
    let no_color = std::env::var("NO_COLOR").is_ok();
    let use_color = force_color || (!no_color && std::io::stdout().is_terminal());

    // Dependencies (tokio, rustls, tao, wry, hyper, ...) log through the same
    // `log` facade; unfiltered, their trace/debug floods the dev console. Show
    // OUR logs (target "tomat" / "tomat::<scope>" / "tomat_lib::...") at the full
    // dev level, but only WARN+ from everything else.
    let our_max = if is_dev {
        log::LevelFilter::Trace
    } else {
        log::LevelFilter::Warn
    };
    let stdout_chain = fern::Dispatch::new()
        .level(log::LevelFilter::Trace)
        .filter(move |meta| {
            let max = if is_ours(meta.target()) {
                our_max
            } else {
                log::LevelFilter::Warn
            };
            meta.level() <= max
        })
        .format(move |out, message, record| {
            let scrubbed = scrub_secrets(&message.to_string());
            let level = paint(
                use_color,
                level_code(record.level()),
                level_label(record.level()),
            );
            let module = match module_name(record.target()) {
                "" => String::new(),
                m => format!("{} ", paint(use_color, "2", m)),
            };
            // Per-line head so a multi-line message (e.g. a pretty-printed error
            // payload) carries the level + module on EVERY line, not just the
            // first - the dev multiplexer then badges each line uniformly.
            let head = if no_time {
                format!("{level} {module}")
            } else {
                format!("{} {level} {module}", paint(use_color, "2", &wall_clock()))
            };
            let body = scrubbed.replace('\n', &format!("\n{head}"));
            out.finish(format_args!("{head}{body}"))
        })
        .chain(std::io::stdout());

    let mut root = fern::Dispatch::new().chain(stdout_chain);

    // File chain is optional: if the home dir / log file can't be opened, keep
    // stdout logging rather than failing boot.
    match file_writer() {
        Ok(writer) => {
            let file_chain = fern::Dispatch::new()
                .level(log::LevelFilter::Warn)
                .format(|out, message, record| {
                    let scrubbed = scrub_secrets(&message.to_string());
                    let ts =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let scope = match module_name(record.target()) {
                        "" => String::new(),
                        m => format!(" [{m}]"),
                    };
                    // Per-line head so multi-line entries stay greppable: each
                    // physical line carries the timestamp + level + scope.
                    let head = format!("{ts} {}{scope} ", record.level());
                    let body = scrubbed.replace('\n', &format!("\n{head}"));
                    out.finish(format_args!("{head}{body}"))
                })
                .chain(fern::Output::writer(writer, "\n"));
            root = root.chain(file_chain);
        }
        Err(e) => eprintln!("[log] file logging disabled: {e}"),
    }

    root.apply()?;
    Ok(())
}

/// Open the size-capped, append-mode log file as a boxed writer. One file
/// (`client.log`) plus a single rotated backup once it passes ~5 MB.
fn file_writer() -> std::io::Result<Box<dyn Write + Send>> {
    let home = std::env::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home directory"))?;
    let path = crate::channel::channel_root(&home)
        .join("client")
        .join("logs")
        .join("client.log");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let rotator = FileRotate::new(
        path,
        AppendCount::new(1),
        ContentLimit::Bytes(5 * 1024 * 1024),
        Compression::None,
        None,
    );
    Ok(Box::new(rotator))
}

// Wall-clock HH:MM:SS.mmm (local), matching core's console timestamp. Only used
// when TOMAT_LOG_NO_TIME is unset (i.e. not under dev.ts, which owns the column).
fn wall_clock() -> String {
    chrono::Local::now().format("%H:%M:%S%.3f").to_string()
}

// SGR color per level, matching core: error red, warn yellow, info green,
// debug/trace dim.
fn level_code(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "31",
        log::Level::Warn => "33",
        log::Level::Info => "32",
        log::Level::Debug | log::Level::Trace => "2",
    }
}

// Lowercase level label, right-padded to width 5 so the next column aligns.
fn level_label(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "error",
        log::Level::Warn => "warn ",
        log::Level::Info => "info ",
        log::Level::Debug => "debug",
        log::Level::Trace => "trace",
    }
}

fn paint(use_color: bool, code: &str, s: &str) -> String {
    if use_color {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

// Our own logs live under the "tomat" target namespace: frontend logs arrive as
// "tomat::<scope>" (via client_log), the crate's own as "tomat_lib::...". Used to
// keep dependency trace/debug out of the dev console.
fn is_ours(target: &str) -> bool {
    target == "tomat" || target.starts_with("tomat::") || target.starts_with("tomat_lib")
}

// The module/scope shown in the terminal + file: strip our "tomat::" prefix so
// it reads as a bare scope ("ws"); empty for the unscoped default. Non-"tomat"
// targets (a dependency surfacing a WARN+) are shown as-is so their origin is
// visible.
fn module_name(target: &str) -> &str {
    match target {
        "tomat" | "default" | "" => "",
        t => t.strip_prefix("tomat::").unwrap_or(t),
    }
}

// Mirrors tomat-core/src/shared/log.ts SCRUBBERS, most-specific-first so labeled
// forms keep their label while the value is masked. Patterns are compile-time
// constants exercised by the unit tests below, so the unwraps cannot fail.
#[allow(clippy::unwrap_used)]
static SCRUBBERS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // Authorization: Bearer <token>
        (
            Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9_\-.~+/=]{16,}").unwrap(),
            "${1}<REDACTED>",
        ),
        // X-Admin-Token: <token> / x-admin-token=<token>
        (
            Regex::new(r"(?i)(x-admin-token\s*[:=]\s*)\S+").unwrap(),
            "${1}<REDACTED>",
        ),
        // ?token=<value> in URLs / WS upgrade query strings.
        (
            Regex::new(r"(?i)(\btoken=)[A-Za-z0-9_\-.]+").unwrap(),
            "${1}<REDACTED>",
        ),
        // Bare base64url tokens (43-char randomToken output; 40+ is safe).
        (Regex::new(r"[A-Za-z0-9_-]{40,}").unwrap(), "<REDACTED>"),
        // Bare hex strings: 32-char admin token, 64-char sha256.
        (Regex::new(r"(?i)\b[a-f0-9]{32,}\b").unwrap(), "<REDACTED>"),
    ]
});

/// Strip credential-shaped substrings from a log line before it is written to
/// disk or stderr. Best-effort defense mirroring core's `scrubSecrets`.
pub fn scrub_secrets(input: &str) -> String {
    let mut out = input.to_string();
    for (re, repl) in SCRUBBERS.iter() {
        out = re.replace_all(&out, *repl).into_owned();
    }
    out
}

/// Forward a frontend log line into the `log` facade so it flows through the
/// same stdout + file sinks as native Rust logs. Fire-and-forget from JS:
/// returns `()` and the level filters decide where it lands.
#[tauri::command]
pub fn client_log(level: String, scope: String, message: String) {
    // Namespace frontend logs under "tomat::" so the stdout filter recognizes
    // them as ours and shows them at the full dev level.
    let target = if scope.is_empty() {
        "tomat".to_string()
    } else {
        format!("tomat::{scope}")
    };
    match level.as_str() {
        "error" => log::error!(target: &target, "{message}"),
        "warn" => log::warn!(target: &target, "{message}"),
        "info" => log::info!(target: &target, "{message}"),
        _ => log::debug!(target: &target, "{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_ours, module_name, scrub_secrets};

    #[test]
    fn is_ours_matches_only_the_tomat_namespace() {
        assert!(is_ours("tomat"));
        assert!(is_ours("tomat::ws"));
        assert!(is_ours("tomat::input-shortcut"));
        assert!(is_ours("tomat_lib::commands::window"));
        // Dependencies must not match.
        assert!(!is_ours("tokio"));
        assert!(!is_ours("rustls::client"));
        assert!(!is_ours("tao::platform_impl"));
        assert!(!is_ours("tauri::manager"));
    }

    #[test]
    fn module_name_strips_our_prefix_and_passes_deps_through() {
        assert_eq!(module_name("tomat::ws"), "ws");
        assert_eq!(module_name("tomat::boot"), "boot");
        assert_eq!(module_name("tomat"), "");
        assert_eq!(module_name("default"), "");
        assert_eq!(module_name(""), "");
        // A dependency that surfaces a WARN+ keeps its target so its origin shows.
        assert_eq!(module_name("rustls"), "rustls");
    }

    #[test]
    fn redacts_bearer_token_keeps_label() {
        let out = scrub_secrets("Authorization: Bearer abcdef0123456789ABCDEF");
        assert!(out.contains("Bearer <REDACTED>"), "got {out}");
        assert!(!out.contains("abcdef0123456789ABCDEF"), "got {out}");
    }

    #[test]
    fn redacts_admin_token_header() {
        let out = scrub_secrets("x-admin-token: deadbeefdeadbeefdeadbeefdeadbeef");
        assert!(out.contains("x-admin-token: <REDACTED>"), "got {out}");
    }

    #[test]
    fn redacts_token_query_param_keeps_key() {
        let out = scrub_secrets("connecting wss://h/ws?token=abc.def-123_XYZ");
        assert!(out.contains("token=<REDACTED>"), "got {out}");
        assert!(!out.contains("abc.def-123_XYZ"), "got {out}");
    }

    #[test]
    fn redacts_bare_base64url_token() {
        // 43-char base64url (randomToken width).
        let token = "A".repeat(43);
        let out = scrub_secrets(&format!("paired with code {token}"));
        assert!(out.contains("<REDACTED>"), "got {out}");
        assert!(!out.contains(&token), "got {out}");
    }

    #[test]
    fn redacts_bare_hex_string() {
        let sha = "a".repeat(64);
        let out = scrub_secrets(&format!("digest {sha}"));
        assert!(out.contains("<REDACTED>"), "got {out}");
        assert!(!out.contains(&sha), "got {out}");
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        let msg = "rejected frame: schema mismatch on kind requirements.snapshot";
        assert_eq!(scrub_secrets(msg), msg);
    }
}
