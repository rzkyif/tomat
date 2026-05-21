//! tomat-core-keychain: tiny native helper that exposes the OS keychain
//! (macOS Keychain, Linux libsecret via secret-service, Windows Credential
//! Manager) to tomat-core through a stdio protocol. tomat-core shells out
//! to this binary instead of bundling Deno FFI bindings against the
//! platform keychain APIs.
//!
//! Usage:
//!   tomat-core-keychain get <service> <account>
//!       Prints the stored password to stdout (with a single trailing \n).
//!       Exits 0 on success.
//!       Exits 1 if no such entry exists (stderr: "ENTRY_MISSING").
//!       Exits 2 on any other error (stderr: human-readable message).
//!
//!   tomat-core-keychain set <service> <account>
//!       Reads the password to store from stdin (all bytes, no
//!       transformation). The caller is responsible for not appending a
//!       trailing newline if it doesn't want one stored. tomat-core writes
//!       a single line of base64.
//!       Exits 0 on success, 2 on error.
//!
//!   tomat-core-keychain delete <service> <account>
//!       Removes the entry. Idempotent — exits 0 whether or not the entry
//!       existed. Exits 2 on other errors.

use std::io::{self, Read, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        usage();
        return ExitCode::from(2);
    }
    let (mode, service, account) = (args[1].as_str(), args[2].as_str(), args[3].as_str());
    match mode {
        "get" => run_get(service, account),
        "set" => run_set(service, account),
        "delete" => run_delete(service, account),
        other => {
            eprintln!("unknown mode: {}", other);
            usage();
            ExitCode::from(2)
        }
    }
}

fn usage() {
    eprintln!("usage: tomat-core-keychain {{get|set|delete}} <service> <account>");
}

fn run_get(service: &str, account: &str) -> ExitCode {
    let entry = match keyring::Entry::new(service, account) {
        Ok(e) => e,
        Err(e) => return fail(format!("keyring::Entry::new failed: {}", e)),
    };
    match entry.get_password() {
        Ok(pw) => {
            // Write raw bytes + a single trailing newline so callers can
            // either `.trim()` the result or read the line directly.
            if let Err(e) = io::stdout().write_all(pw.as_bytes()) {
                return fail(format!("stdout write failed: {}", e));
            }
            let _ = io::stdout().write_all(b"\n");
            ExitCode::from(0)
        }
        Err(keyring::Error::NoEntry) => {
            eprintln!("ENTRY_MISSING");
            ExitCode::from(1)
        }
        Err(e) => fail(format!("get_password failed: {}", e)),
    }
}

fn run_set(service: &str, account: &str) -> ExitCode {
    let mut buf = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buf) {
        return fail(format!("stdin read failed: {}", e));
    }
    let entry = match keyring::Entry::new(service, account) {
        Ok(e) => e,
        Err(e) => return fail(format!("keyring::Entry::new failed: {}", e)),
    };
    match entry.set_password(&buf) {
        Ok(()) => ExitCode::from(0),
        Err(e) => fail(format!("set_password failed: {}", e)),
    }
}

fn run_delete(service: &str, account: &str) -> ExitCode {
    let entry = match keyring::Entry::new(service, account) {
        Ok(e) => e,
        Err(e) => return fail(format!("keyring::Entry::new failed: {}", e)),
    };
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => ExitCode::from(0),
        Err(e) => fail(format!("delete_credential failed: {}", e)),
    }
}

fn fail(msg: String) -> ExitCode {
    eprintln!("{}", msg);
    ExitCode::from(2)
}
