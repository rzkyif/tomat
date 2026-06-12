//! tomat-core-ptyhost: PTY plumbing between tomat-core and a Deno tool
//! worker. Deno only shows its interactive permission prompt when the
//! worker's stdin AND stderr are terminals, so this helper allocates a
//! pseudo-terminal, attaches the worker's stdin + stderr to the slave side,
//! and bridges the master side to the core over a small NDJSON protocol.
//! The worker's stdout is inherited, so the core<->worker NDJSON stream
//! passes through this process untouched; ptyhost itself never writes to
//! its own stdout.
//!
//! Control frames (core -> ptyhost, one JSON object per line on stdin):
//!   {"kind":"spawn","cmd":"/path/to/deno","args":[...],"env":{...},"cwd":null}
//!       Must be the first frame, exactly once. The child's environment is
//!       exactly `env` (nothing inherited).
//!   {"kind":"write","dataB64":"..."}
//!       Raw bytes for the PTY master: worker-protocol frames and prompt
//!       answers alike. The core does not distinguish; this helper is a
//!       dumb pipe.
//!   {"kind":"kill"}
//!       SIGKILL the child.
//!
//! Events (ptyhost -> core, one JSON object per line on stderr):
//!   {"kind":"pty","dataB64":"..."}   PTY master output (worker stderr +
//!                                    Deno prompt text; never stdout).
//!   {"kind":"exit","code":N}         Child exited; ptyhost then exits with
//!                                    the same code.
//!   {"kind":"fatal","error":"..."}   Allocation/spawn failure; ptyhost exits.
//!
//! On stdin EOF (core died) the child is SIGKILLed and ptyhost exits. The
//! PTY slave is switched to raw mode (no echo, no canonical line limit, no
//! output post-processing) so large protocol frames survive the trip and
//! written bytes do not echo back into the master stream.

use std::io::{BufRead, Write};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ControlFrame {
    Spawn {
        cmd: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::HashMap<String, String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Write {
        #[serde(rename = "dataB64")]
        data_b64: String,
    },
    Kill,
}

/// Serializes event lines so concurrent threads (PTY reader, child waiter,
/// control loop) never interleave partial lines on stderr.
static EVENT_LOCK: Mutex<()> = Mutex::new(());

fn emit_event(json: String) {
    let guard = EVENT_LOCK.lock();
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(json.as_bytes());
    let _ = err.write_all(b"\n");
    let _ = err.flush();
    drop(guard);
}

fn emit_pty(data: &[u8]) {
    emit_event(format!(
        "{{\"kind\":\"pty\",\"dataB64\":\"{}\"}}",
        B64.encode(data)
    ));
}

fn emit_exit(code: i32) {
    emit_event(format!("{{\"kind\":\"exit\",\"code\":{code}}}"));
}

fn emit_fatal(error: &str) -> ! {
    // serde_json::to_string on a &str cannot fail; fall back to a fixed
    // message rather than unwrapping.
    let quoted = serde_json::to_string(error).unwrap_or_else(|_| "\"fatal\"".to_string());
    emit_event(format!("{{\"kind\":\"fatal\",\"error\":{quoted}}}"));
    std::process::exit(70);
}

#[cfg(unix)]
fn main() {
    unix::run();
}

#[cfg(not(unix))]
fn main() {
    // Windows needs a ConPTY backend, which is not implemented yet. Exit with
    // a distinctive code so the core's legacy-spawn fallback engages.
    emit_fatal("ptyhost is not supported on this platform");
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::fd::{AsFd, AsRawFd};
    use std::os::unix::process::CommandExt;

    use nix::pty::openpty;
    use nix::sys::signal::{kill, Signal};
    use nix::sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg};
    use nix::unistd::Pid;

    pub fn run() {
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();

        // First frame must be spawn.
        let first = match lines.next() {
            Some(Ok(line)) => line,
            _ => return, // EOF before spawn: nothing to do.
        };
        let spawn = match serde_json::from_str::<ControlFrame>(&first) {
            Ok(f @ ControlFrame::Spawn { .. }) => f,
            Ok(_) => emit_fatal("first control frame must be spawn"),
            Err(e) => emit_fatal(&format!("bad control frame: {e}")),
        };
        let ControlFrame::Spawn {
            cmd,
            args,
            env,
            cwd,
        } = spawn
        else {
            unreachable!()
        };

        let pty = match openpty(None, None) {
            Ok(p) => p,
            Err(e) => emit_fatal(&format!("openpty failed: {e}")),
        };

        // Raw mode on the slave: no echo (written frames must not bounce back
        // into the master stream), no canonical mode (its ~1 KB line limit
        // would mangle large protocol frames), no output post-processing.
        match tcgetattr(pty.slave.as_fd()) {
            Ok(mut t) => {
                cfmakeraw(&mut t);
                if let Err(e) = tcsetattr(pty.slave.as_fd(), SetArg::TCSANOW, &t) {
                    emit_fatal(&format!("tcsetattr failed: {e}"));
                }
            }
            Err(e) => emit_fatal(&format!("tcgetattr failed: {e}")),
        }

        let (stdin_fd, stderr_fd) = match (pty.slave.try_clone(), pty.slave.try_clone()) {
            (Ok(a), Ok(b)) => (a, b),
            _ => emit_fatal("failed to clone pty slave fd"),
        };

        let slave_raw = pty.slave.as_raw_fd();
        let mut command = std::process::Command::new(&cmd);
        command
            .args(&args)
            .env_clear()
            .envs(&env)
            .stdin(std::process::Stdio::from(stdin_fd))
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::from(stderr_fd));
        if let Some(dir) = &cwd {
            command.current_dir(dir);
        }
        // SAFETY: setsid + TIOCSCTTY are async-signal-safe; required so the
        // PTY becomes the child's controlling terminal (Deno's prompt reads
        // the answer from the terminal it controls).
        unsafe {
            command.pre_exec(move || {
                if nix::libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if nix::libc::ioctl(slave_raw, nix::libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) => emit_fatal(&format!("spawn failed: {e}")),
        };
        let child_pid = Pid::from_raw(child.id() as i32);
        // Drop our slave fd so the master read errors out (EIO) once the
        // child's copies close, ending the reader thread.
        drop(pty.slave);

        let master_writer = match pty.master.try_clone() {
            Ok(fd) => fd,
            Err(_) => emit_fatal("failed to clone pty master fd"),
        };

        // PTY master -> core: chunked, base64-wrapped events.
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match nix::unistd::read(pty.master.as_raw_fd(), &mut buf) {
                    Ok(0) => break,
                    Ok(n) => emit_pty(&buf[..n]),
                    // EIO: every slave fd closed (child exited). Anything
                    // else is equally terminal for the bridge.
                    Err(_) => break,
                }
            }
        });

        // Child exit -> drain the reader, report, and mirror the exit code.
        // Exits the whole process: ptyhost must not outlive its child (the
        // core awaits this process's status as the worker's status).
        let waiter = std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) =>
                {
                    #[allow(clippy::unwrap_used, reason = "signal() is Some when code() is None")]
                    status.code().unwrap_or_else(|| {
                        128 + std::os::unix::process::ExitStatusExt::signal(&status).unwrap_or(9)
                    })
                }
                Err(_) => 70,
            };
            let _ = reader.join();
            emit_exit(code);
            std::process::exit(code);
        });

        // Control loop: forward writes to the master, honor kill, kill on EOF.
        for line in lines {
            let Ok(line) = line else { break };
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<ControlFrame>(&line) {
                Ok(ControlFrame::Write { data_b64 }) => {
                    let Ok(bytes) = B64.decode(data_b64) else {
                        continue;
                    };
                    let mut off = 0;
                    while off < bytes.len() {
                        match nix::unistd::write(master_writer.as_fd(), &bytes[off..]) {
                            Ok(n) => off += n,
                            Err(_) => break,
                        }
                    }
                }
                Ok(ControlFrame::Kill) => {
                    let _ = kill(child_pid, Signal::SIGKILL);
                }
                Ok(ControlFrame::Spawn { .. }) => {
                    // One child per ptyhost; a second spawn is a core bug.
                    // Killing the child makes the waiter thread exit the
                    // process with the child's code.
                    let _ = kill(child_pid, Signal::SIGKILL);
                    let _ = waiter.join();
                    emit_fatal("duplicate spawn frame");
                }
                Err(_) => continue, // tolerate garbage; the core logs its own errors
            }
        }

        // stdin EOF or read error: the core is gone, take the child with us.
        // The waiter thread exits the process once the child is reaped.
        let _ = kill(child_pid, Signal::SIGKILL);
        let _ = waiter.join();
        std::process::exit(70);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::unwrap_used)]
    fn parses_spawn_frame() {
        let f: ControlFrame = serde_json::from_str(
            r#"{"kind":"spawn","cmd":"/bin/deno","args":["run"],"env":{"A":"1"},"cwd":null}"#,
        )
        .unwrap();
        match f {
            ControlFrame::Spawn {
                cmd,
                args,
                env,
                cwd,
            } => {
                assert_eq!(cmd, "/bin/deno");
                assert_eq!(args, vec!["run"]);
                assert_eq!(env.get("A").map(String::as_str), Some("1"));
                assert_eq!(cwd, None);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn parses_write_and_kill_frames() {
        let w: ControlFrame = serde_json::from_str(r#"{"kind":"write","dataB64":"aGk="}"#).unwrap();
        match w {
            ControlFrame::Write { data_b64 } => {
                assert_eq!(B64.decode(data_b64).unwrap(), b"hi");
            }
            _ => panic!("wrong variant"),
        }
        let k: ControlFrame = serde_json::from_str(r#"{"kind":"kill"}"#).unwrap();
        assert!(matches!(k, ControlFrame::Kill));
    }

    #[test]
    fn pty_event_encoding_is_one_json_line() {
        let line = format!(
            "{{\"kind\":\"pty\",\"dataB64\":\"{}\"}}",
            B64.encode(b"a\nb")
        );
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(parsed["kind"], "pty");
        assert_eq!(
            B64.decode(parsed["dataB64"].as_str().expect("string"))
                .expect("b64"),
            b"a\nb"
        );
    }
}
