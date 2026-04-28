# AGENTS.md

## Project Overview

Tomat is a local-first modular AI client built as a desktop app. It runs LLMs and speech-to-text locally via llama.cpp and whisper.cpp sidecars, with optional external OpenAI-compatible API support. The app presents as an always-on-top overlay with click-through behavior.

**Tech stack:** Tauri 2 (Rust) + Svelte 5 (TypeScript) + Bun sidecar (Elysia)

**Key directories:**

- `src/` - Svelte frontend (components, state via Svelte 5 runes, sidecar communication)
- `src-tauri/src/` - Rust backend (sidecar lifecycle, file I/O, window management, Tauri commands)
- `src-bun/` - Bun/Elysia HTTP sidecar server
- `scripts/` - Build utilities (`fetch-required-files.mjs` downloads platform binaries)

## Binary provenance

Sidecar binaries (llama.cpp, whisper.cpp, bun) are not committed. They are
downloaded by `bun run fetch` into `src-tauri/binaries/`. Two committed files
pin and verify those downloads:

- `src-tauri/binaries/versions.json` - pinned version tag per binary.
- `src-tauri/binaries/checksums.json` - expected SHA-256 per archive per platform.

`bun run fetch` reads these and refuses to proceed on any hash mismatch. When
bumping an upstream version, run `bun run fetch --update` (maintainer mode):
this fetches latest releases, downloads them, and rewrites both files. Review
the diff and commit.

## Before a Task

- Read the relevant source files before making changes. Understand existing patterns and styling.
- Check `src/lib/shared/settings.ts` for the declarative settings schema if the task involves configuration or features.
- Check `src/lib/shared/command.ts` for the command argument builder if the task involves sidecar CLI args.
- Check `src-tauri/src/commands/` (split by domain: `session`, `snippets`, `settings`, `storage`, `paths`, plus window/sidecar commands in `mod.rs`) for existing Tauri commands before adding new ones.
- Check `src-tauri/src/error.rs` for the unified `AppError` type - new Tauri commands should return `AppResult<T>` and use `?` rather than `map_err(|e| e.to_string())`.
- Check `src-tauri/src/sidecar.rs` for sidecar process management patterns.
- Check `src/lib/state/` for existing reactive state classes before introducing new state.
- Check `src/lib/shared/env.ts` (`isTauri()`) and `src/lib/shared/network.ts` (sidecar host/port constants) before adding platform detection or URL literals.

## After a Task

- Run `bun run check:js` (runs `svelte-kit sync`, `svelte-check`, and `oxlint`) IF you made changes in the JS codebase.
- Run `bun run check:rs` (runs `cargo check` and `cargo clippy`) IF you made changes in the Rust codebase.
- Run `bun run format` (runs `oxfmt` and `cargo fmt`) before committing.
- Fix any errors before finishing.
- Review whether `README.md` and this file should be updated to reflect the changes (new features, changed setup steps, new scripts, updated architecture, etc.).

## General Rules

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
