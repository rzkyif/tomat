# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a
stable release exists.

## [Unreleased]

### Added

- SHA-256 verification of downloaded `llama-server` / `whisper-server` / `bun` binaries against a committed `src-tauri/binaries/checksums.json` manifest. Maintainer flow: `bun run fetch --update` to refresh the manifest.
- OS keychain storage for secret settings (e.g. `llm.external.apiKey`, `stt.external.apiKey`) via the `keyring` crate.
- Graceful subprocess shutdown: superseded sidecars get SIGTERM first, then SIGKILL after a 5s grace period, in a detached task.
- Message-list windowing (default 200) with a "Load older" control, to keep rendering cheap for long sessions.
- Token-stream coalescing (~30 ms) to drop markdown re-parse cost during streaming.
- URL validator on external LLM/STT base URLs: HTTPS required for remote hosts, HTTP only allowed for loopback.
- CI workflow (`.github/workflows/ci.yml`) running lint, type-check, and `cargo check` on Linux/macOS/Windows.
- `rust-toolchain.toml` and `.bun-version` pin the build toolchain.

### Changed

- `save_chat_history` is now async (`tokio::fs`) with atomic `.tmp → rename` semantics; frontend save is debounced (1s trailing edge).
- `download_mutex` replaced by `Semaphore::new(2)` to allow two concurrent model downloads.
- `metrics` guarded by `tokio::sync::RwLock` rather than `std::sync::Mutex`.
- Bun sidecar binds explicitly to `127.0.0.1:7703` (was 0.0.0.0-equivalent).
- `UserInput.svelte` decomposed: VAD → [src/lib/shared/vad.svelte.ts](src/lib/shared/vad.svelte.ts), shortcut handling → [src/lib/state/shortcut.svelte.ts](src/lib/state/shortcut.svelte.ts), capture → [src/lib/shared/capture.ts](src/lib/shared/capture.ts).
- Streaming text append now uses immutable updates on the message object rather than nested property mutation.
- Secret routing is driven entirely by `type: "password"` in [src/lib/shared/settings.ts](src/lib/shared/settings.ts). The `SECRET_KEYS` constant in `commands.rs` and the `check-secret-keys` lint are gone; adding a new password field no longer requires a Rust or CI change.

### Fixed

- Health-check URL validator no longer silently passes URLs without a host.
- Mutex-poisoning path in sidecar supervisor now emits a `ServerStatus::Error` event to the frontend instead of only logging to stderr.
- `UserMessage.svelte` pending edit timeout is now cleared on component destroy.
