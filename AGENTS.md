# AGENTS.md

## Project Overview

Tomat is a local-first modular AI client built as a desktop app. It runs LLMs and speech-to-text locally via llama.cpp and whisper.cpp sidecars, with optional external OpenAI-compatible API support. The app presents as an always-on-top overlay with click-through behavior.

**Tech stack:** Tauri 2 (Rust) + Svelte 5 (TypeScript) + Bun sidecar (Elysia)

**Key directories:**

- `src/` — Svelte frontend (components, state via Svelte 5 runes, sidecar communication)
- `src-tauri/src/` — Rust backend (sidecar lifecycle, file I/O, window management, Tauri commands)
- `src-bun/` — Bun/Elysia HTTP sidecar server
- `scripts/` — Build utilities (`fetch-required-files.mjs` downloads platform binaries)

## Binary provenance

Sidecar binaries (llama.cpp, whisper.cpp, bun) are not committed. They are
downloaded by `bun run fetch` into `src-tauri/binaries/`. Two committed files
pin and verify those downloads:

- `src-tauri/binaries/versions.json` — pinned version tag per binary.
- `src-tauri/binaries/checksums.json` — expected SHA-256 per archive per platform.

`bun run fetch` reads these and refuses to proceed on any hash mismatch. When
bumping an upstream version, run `bun run fetch --update` (maintainer mode):
this fetches latest releases, downloads them, and rewrites both files. Review
the diff and commit.

## Before a Task

- Read the relevant source files before making changes. Understand existing patterns and styling.
- Check `src/lib/shared/settings.ts` for the declarative settings schema if the task involves configuration or features.
- Check `src/lib/shared/command.ts` for the command argument builder if the task involves sidecar CLI args.
- Check `src-tauri/src/commands.rs` for existing Tauri commands before adding new ones.
- Check `src-tauri/src/sidecar.rs` for sidecar process management patterns.
- Check `src/lib/state/` for existing reactive state classes before introducing new state.

## After a Task

- Run `bun run check:js` (runs `oxlint`, `oxfmt`, and `svelte-check`) IF you made changes in the JS codebase.
- Run `bun run check:rs` (runs `cargo check`) IF you made changes in the Rust codebase.
- Fix any errors before finishing.
- Review whether `README.md` and this file should be updated to reflect the changes (new features, changed setup steps, new scripts, updated architecture, etc.).
