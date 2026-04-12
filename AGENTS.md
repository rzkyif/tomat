# AGENTS.md

## Project Overview

Tomat is a local-first modular AI client built as a desktop app. It runs LLMs and speech-to-text locally via llama.cpp and whisper.cpp sidecars, with optional external OpenAI-compatible API support. The app presents as an always-on-top overlay with click-through behavior.

**Tech stack:** Tauri 2 (Rust) + Svelte 5 (TypeScript) + Bun sidecar (Elysia)

**Key directories:**

- `src/` — Svelte frontend (components, state via Svelte 5 runes, sidecar communication)
- `src-tauri/src/` — Rust backend (sidecar lifecycle, file I/O, window management, Tauri commands)
- `src-bun/` — Bun/Elysia HTTP sidecar server
- `scripts/` — Build utilities (`fetch-required-files.mjs` downloads platform binaries)

## Before a Task

- Read the relevant source files before making changes. Understand existing patterns and styling.
- Check `src/lib/shared/settings.ts` for the declarative settings schema if the task involves configuration or features.
- Check `src/lib/shared/command.ts` for the command argument builder if the task involves sidecar CLI args.
- Check `src-tauri/src/commands.rs` for existing Tauri commands before adding new ones.
- Check `src-tauri/src/sidecar.rs` for sidecar process management patterns.
- Check `src/lib/state/` for existing reactive state classes before introducing new state.

## After a Task

- Run `bun run check` (runs `oxlint`, `oxfmt`, `svelte-check`, and `cargo check`). Fix any errors before finishing.
- Review whether `README.md` and this file should be updated to reflect the changes (new features, changed setup steps, new scripts, updated architecture, etc.).
