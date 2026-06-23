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
//!       Worker-protocol frames for the PTY master. These echo back off the
//!       slave (ECHO is on, see below); the reader cancels that echo.
//!   {"kind":"answer","dataB64":"..."}
//!       A permission-prompt answer for the PTY master. Identical to `write`
//!       except it is NOT echo-tracked: Deno reads the answer with echo off,
//!       so it never bounces back and must not seed the echo-cancel queue.
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
//! On stdin EOF (core died) the child is SIGKILLed and ptyhost exits. The PTY
//! slave runs with no canonical line limit and no output post-processing so
//! large protocol frames survive the trip, but ECHO stays on: Deno 2.8.3 refuses
//! to prompt when stdin is in raw mode (ICANON and ECHO both off), so disabling
//! echo would silence permission prompts. The master reader cancels the echo of
//! everything written via `write` so the core never sees its own frames.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

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
    /// Worker-protocol bytes for the master; echo-tracked so the slave's
    /// bounce-back is cancelled before it reaches the core.
    Write {
        #[serde(rename = "dataB64")]
        data_b64: String,
    },
    /// Permission-prompt answer for the master; NOT echo-tracked (Deno reads it
    /// with echo off, so it never bounces back).
    Answer {
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

// Cap the outstanding-echo queue. A byte that never echoes back (e.g. the slave
// briefly disabled ECHO) would otherwise wedge the queue and swallow real output
// forever; past this bound we assume desync, drop the backlog, and let any stray
// echo through as harmless stderr noise. Comfortably above one protocol frame.
#[cfg(unix)]
const PENDING_ECHO_CAP: usize = 4 * 1024 * 1024;

/// Record bytes written to the master that the slave's ECHO will bounce back,
/// so the reader can drop them. Clears the backlog on overflow (desync guard).
#[cfg(unix)]
fn expect_echo(pending: &Mutex<std::collections::VecDeque<u8>>, bytes: &[u8]) {
    if let Ok(mut q) = pending.lock() {
        if q.len() + bytes.len() > PENDING_ECHO_CAP {
            q.clear();
            return;
        }
        q.extend(bytes.iter().copied());
    }
}

/// Strip leading echoed bytes from a master read: each byte that matches the
/// head of `pending` is its own echo and is dropped; the rest is genuine child
/// output (prompt text or stderr). Echoed frames bounce back contiguously, so a
/// running prefix match cancels them; a coincidental match only ever drops a
/// byte of a stderr log line, never protocol output (which rides stdout).
#[cfg(unix)]
fn cancel_echo(pending: &Mutex<std::collections::VecDeque<u8>>, chunk: &[u8]) -> Vec<u8> {
    let Ok(mut q) = pending.lock() else {
        return chunk.to_vec();
    };
    let mut out = Vec::with_capacity(chunk.len());
    for &b in chunk {
        if q.front() == Some(&b) {
            q.pop_front();
        } else {
            out.push(b);
        }
    }
    out
}

/// Write all of `bytes` to `fd`, retrying short writes and giving up on error.
#[cfg(unix)]
fn write_all(fd: std::os::fd::BorrowedFd<'_>, bytes: &[u8]) {
    let mut off = 0;
    while off < bytes.len() {
        match nix::unistd::write(fd, &bytes[off..]) {
            Ok(n) => off += n,
            Err(_) => break,
        }
    }
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

        // Slave line discipline: no canonical mode (its ~1 KB line limit would
        // mangle large protocol frames) and no output post-processing, but ECHO
        // stays ON. Deno 2.8.3 refuses to show a permission prompt when stdin is
        // in raw mode, which it defines as `c_lflag & (ICANON | ECHO) == 0` (see
        // denoland/deno#34457); leaving ECHO set keeps prompts working. The cost
        // is that every byte written to the master is echoed back into it; the
        // PTY reader below cancels that echo so it never reaches the core.
        match tcgetattr(pty.slave.as_fd()) {
            Ok(mut t) => {
                use nix::sys::termios::LocalFlags;
                cfmakeraw(&mut t);
                t.local_flags.insert(LocalFlags::ECHO);
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
        // Guard the child PID so a control-frame kill can't fire AFTER the waiter
        // has reaped the child (whose PID the kernel may have recycled into an
        // unrelated process). The waiter sets it to None on reap; every kill site
        // takes the lock and skips when None.
        let live_pid = Arc::new(Mutex::new(Some(child_pid)));
        let waiter_pid = Arc::clone(&live_pid);
        let kill_live = || {
            if let Ok(guard) = live_pid.lock() {
                if let Some(p) = *guard {
                    let _ = kill(p, Signal::SIGKILL);
                }
            }
        };
        // Drop our slave fd so the master read errors out (EIO) once the
        // child's copies close, ending the reader thread.
        drop(pty.slave);

        let master_writer = match pty.master.try_clone() {
            Ok(fd) => fd,
            Err(_) => emit_fatal("failed to clone pty master fd"),
        };

        // Echo cancellation: the slave echoes every byte written to the master
        // (ECHO is on so Deno still prompts), so each protocol frame the core
        // writes bounces straight back. `pending_echo` holds the bytes still
        // owed an echo; the reader drops them so the core never sees its own
        // frames. Only protocol writes are tracked here: prompt answers go out
        // the `answer` frame, which Deno reads with echo disabled, so tracking
        // them would leave a stuck prefix and desync the queue.
        let pending_echo = Arc::new(Mutex::new(std::collections::VecDeque::<u8>::new()));
        let reader_echo = Arc::clone(&pending_echo);

        // PTY master -> core: chunked, base64-wrapped events, echo stripped.
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match nix::unistd::read(pty.master.as_raw_fd(), &mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let out = cancel_echo(&reader_echo, &buf[..n]);
                        if !out.is_empty() {
                            emit_pty(&out);
                        }
                    }
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
            // Child reaped: forbid any further signal to its now-recyclable PID.
            if let Ok(mut guard) = waiter_pid.lock() {
                *guard = None;
            }
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
                    // Expect this frame to echo back; queue it (before the write,
                    // so the reader can't race ahead) so the reader can cancel it.
                    expect_echo(&pending_echo, &bytes);
                    write_all(master_writer.as_fd(), &bytes);
                }
                Ok(ControlFrame::Answer { data_b64 }) => {
                    let Ok(bytes) = B64.decode(data_b64) else {
                        continue;
                    };
                    // Prompt answer: Deno reads it with echo off, so it does not
                    // bounce back. Write straight through without echo tracking.
                    write_all(master_writer.as_fd(), &bytes);
                }
                Ok(ControlFrame::Kill) => {
                    kill_live();
                }
                Ok(ControlFrame::Spawn { .. }) => {
                    // One child per ptyhost; a second spawn is a core bug. SIGKILL
                    // the child (the kernel delivers it even as we exit) and emit
                    // the documented fatal frame. emit_fatal diverges, so the
                    // waiter thread is abandoned as the process exits.
                    kill_live();
                    emit_fatal("duplicate spawn frame");
                }
                Err(_) => continue, // tolerate garbage; the core logs its own errors
            }
        }

        // stdin EOF or read error: the core is gone, take the child with us.
        // The waiter thread exits the process once the child is reaped.
        kill_live();
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
    fn parses_answer_frame() {
        let a: ControlFrame =
            serde_json::from_str(r#"{"kind":"answer","dataB64":"eQo="}"#).unwrap();
        match a {
            ControlFrame::Answer { data_b64 } => {
                assert_eq!(B64.decode(data_b64).unwrap(), b"y\n");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn echo_cancel_strips_own_writes_and_keeps_real_output() {
        use std::collections::VecDeque;
        let q = Mutex::new(VecDeque::<u8>::new());
        // A protocol frame is written, then bounces straight back: fully cancelled.
        expect_echo(&q, b"{\"k\":1}\n");
        assert_eq!(cancel_echo(&q, b"{\"k\":1}\n"), b"");
        assert!(q.lock().unwrap().is_empty());
        // With nothing pending, genuine child output passes through untouched.
        assert_eq!(cancel_echo(&q, b"hello\n"), b"hello\n");
    }

    #[cfg(unix)]
    #[test]
    fn echo_cancel_passes_real_output_interleaved_after_echo() {
        use std::collections::VecDeque;
        let q = Mutex::new(VecDeque::<u8>::new());
        expect_echo(&q, b"AB");
        // Echo arrives first (cancelled), then real output in the same read.
        assert_eq!(cancel_echo(&q, b"ABxy"), b"xy");
        assert!(q.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn echo_cancel_recovers_from_overflow() {
        use std::collections::VecDeque;
        let q = Mutex::new(VecDeque::<u8>::new());
        let huge = vec![b'z'; PENDING_ECHO_CAP + 1];
        expect_echo(&q, &huge); // overflow: backlog dropped rather than wedged
        assert!(q.lock().unwrap().is_empty());
        // Queue is clear, so output flows instead of being swallowed forever.
        assert_eq!(cancel_echo(&q, b"ok"), b"ok");
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
