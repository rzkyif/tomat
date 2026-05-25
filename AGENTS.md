# AGENTS.md

## Project Overview

Tomat is a local-first modular AI client split into two installable packages
that communicate over an HTTP+WS API, plus helper binaries, a bundled toolkit,
and a distribution website:

- **`@tomat/core`** — Deno service that owns every stateful and computational
  concern: session/messages storage, LLM streaming, tool execution (in sandboxed
  Deno subprocesses), TTS/STT supervision, model + binary downloads, NPM-based
  toolkit installation, embedding-based tool relevance, multi-client auth via
  pairing codes, self-update.
- **`@tomat/core-updater`** — tiny standalone Deno entry compiled to its own
  binary (`tomat-core-updater`) that ships alongside core. Invoked by core's
  self-updater flow: waits for core to exit, swaps the staged binary into place,
  restarts core. Lives in its own package so the binary boundary is obvious from
  the layout.
- **`@tomat/core-keychain`** — small Rust crate compiled to its own binary
  (`tomat-core-keychain`) that ships alongside core. Reads, writes, and deletes
  secret entries in the platform keychain (macOS Keychain, Linux libsecret,
  Windows Credential Manager) over a stdio protocol, so core can seal its master
  key without pulling native FFI into the Deno process.
- **`@tomat/client`** — Tauri+Svelte desktop UI that's intentionally "dumb": it
  renders, captures input, plays audio, manages global shortcuts, and talks to
  one or more paired cores over the API. **Absolute rule**: nothing under
  `packages/tomat-client/src/ui/` outside `lib/platform/tauri.ts` may import
  from `@tauri-apps/*`. Add a method to the `Platform` interface in
  `lib/platform/index.ts` instead, implement it in `tauri.ts`, stub it in
  `web.ts`, then call `platform().<namespace>.<method>()`. Enforced by the
  `tomat/no-tauri-import` deno-lint plugin (for `.ts`) and
  `scripts/lint-plugins/check-tauri-imports-svelte.ts` (for `.svelte`); both run
  as part of `deno task lint`.
- **`@tomat/shared`** — pure TypeScript types + Zod validators consumed by both:
  API contract, domain shapes, `tools.json` schema, WS frame unions.
- **`@tomat/builtin-toolkit`** — reference toolkit bundling three sample tools
  (`download_url`, `open_website`, `askuser_demo`). Published to npm like any
  third-party toolkit and installed by default on a fresh core; doubles as the
  worked example for the `tools.json` format.
- **`@tomat/website`** — Astro static site deployed to Cloudflare Workers
  (Static Assets). Serves the landing page, signed manifests, install scripts,
  and the published `tools.json` JSON Schema at `au.tomat.ing`. Compiled core
  binaries are hosted separately in an R2 public bucket at `get.au.tomat.ing`
  (direct fetch, zero Worker cost).

**Tech stack:** Deno 2 + Hono + SQLite (`jsr:@db/sqlite`) for the core; Tauri
2 + Svelte 5 + Vite + UnoCSS for the client. Deno-first workspace — no
`package.json`, no `bun`, no pnpm; the client invokes Vite and the Tauri CLI
through `npm:` specifiers from `deno task`.

**Key directories:**

- `packages/tomat-core/src/` — service modules organized by concern (`http/`,
  `ws/`, `services/`, `sidecars/`, `toolkits/`, `models/`, `binaries/`,
  `downloads/`, `db/`, `shared/`, `update/`, `workers/`). The `update/` folder
  holds the self-update orchestrator (`self-updater.ts`) and boot-time rollback
  check (`rollback.ts`); the binary that actually performs the swap is built
  from the separate `@tomat/core-updater` package.
- `packages/tomat-core-updater/src/main.ts` — single-file standalone updater
  entry. Built to its own binary by `scripts/build-core.ts` and
  `scripts/website/deploy.ts`.
- `packages/tomat-core-keychain/src/` — Rust crate for the OS-keychain helper.
  Built to its own binary by the same two scripts.
- `packages/tomat-client/src/ui/` — Svelte 5 SPA. `lib/core/` is the HTTP+WS
  client; `lib/platform/` is the host abstraction; `lib/state/` holds the Svelte
  5 runes-based reactive stores.
- `packages/tomat-client/src/tauri/src/` — slimmed Rust crate. Only
  platform-specific commands (window, capture, fonts, volume, shortcuts,
  pairing, client_settings, keychain) and file-to-markdown conversion.
- `packages/tomat-shared/src/` — types + Zod schemas.
- `packages/tomat-builtin-toolkit/` — flat toolkit package (`tools.json`,
  `index.ts`, `src/`); the reference for the toolkit author API.
- `packages/tomat-website/` — Astro site (`src/pages/`, `src/styles/`,
  `public/`). Built by `scripts/website/deploy.ts`; staged release artifacts
  (manifests, install scripts, schemas) land under `public/` at build time and
  are gitignored.
- `scripts/` — `dev.ts`, `build-core.ts`, `build-client.ts`, `check.ts`,
  `install/core.{sh,ps1}`, `website/{dev,deploy}.ts`.

## Persistence Layout

Everything lives under `~/.tomat/`:

```
~/.tomat/
├── core/                       # owned by tomat-core
│   ├── settings.json           # sparse: only non-defaults
│   ├── secrets.enc             # sealed with key in OS keychain
│   ├── .admin-token            # chmod 600; mint pairing codes on local host
│   ├── core.sqlite             # sessions, messages, attachments, toolkits, tools, grants, downloads, clients, pairing_codes
│   ├── bin/                    # platform-neutral filenames (triple stripped)
│   │   ├── tomat-core(.exe), tomat-core-updater(.exe), tomat-core-keychain(.exe)
│   │   ├── llama-server(.exe), whisper-server(.exe), deno(.exe)
│   │   └── lib/                # ggml/whisper shared libs for this host's triple
│   ├── deno-cache/             # DENO_DIR for every spawned Deno subprocess
│   ├── sessions/<id>/attachments/...
│   ├── models/<hf-user>/<repo>/<file>
│   ├── toolkits/<id>/          # flat layout; tools.json at folder root
│   │   ├── tools.json, deno.json, deno.lock, package.json, .gitignore
│   │   └── node_modules/       # populated by `deno install`, excluded from content hash
│   ├── cache/binaries-manifest.json     # signed manifest cache
│   ├── staging/                # self-update target dir
│   └── logs/core.log           # rotated, 5×10 MB
└── client/                     # owned by tomat-client
    └── settings.json           # sparse: only non-defaults (UI prefs + paired-cores list)
```

Pairing tokens (one per paired core) live in the OS keychain under the service
`tomat-client` and account `core:<coreId>`.

## File Naming

Filename casing follows the host language's idiom and is consistent across the
monorepo:

- **TypeScript** (`.ts`, `.svelte.ts`): `kebab-case` (e.g. `core-settings.ts`,
  `use-responsive-layout.svelte.ts`).
- **Svelte components** (`.svelte`): `PascalCase` (e.g. `UserMessage.svelte`).
- **Rust** (`.rs`): `snake_case` per Cargo convention.
- **Folders**: `kebab-case` (e.g. `ui/lib/state`, `domain/settings/groups`).
- **Scripts** under `scripts/`: `kebab-case`.

One exception: a `*.test.ts` co-located with a `*.svelte` component mirrors the
component's name (`Toggle.test.ts` next to `Toggle.svelte`). Tests for plain
`.ts` modules follow the TypeScript rule (`core-settings.test.ts` next to
`core-settings.ts`).

Identifiers in code (variables, functions, types, setting-group `id` strings)
follow TypeScript convention (`camelCase` / `PascalCase`) independent of
filename casing. Never rename a setting `id` because the file was renamed: those
strings are persisted in `~/.tomat/core/settings.json` and on the wire.

## Before a Task

- Read the relevant source files before making changes. Understand existing
  patterns and styling.
- Domain types and the API contract live in `packages/tomat-shared/src/`. When
  changing the wire format, update the shared package first.
- Core HTTP routes are in `packages/tomat-core/src/http/routes/`. WS frames in
  `packages/tomat-shared/src/api/ws.ts`. Settings keys consumed by core are
  documented in the header of `packages/tomat-core/src/services/chat.ts`.
- Client API access goes through `packages/tomat-client/src/ui/lib/core/`.
  Platform-specific Tauri calls go through
  `packages/tomat-client/src/ui/lib/platform/`.
- Toolkit author API: `packages/tomat-shared/src/validation/tools-json.ts` (Zod
  schema) + `packages/tomat-shared/src/tools-json-schema.json` (published JSON
  Schema for editor IDE support).
- Library reuse policy: prefer maintained npm/JSR packages over hand-rolled
  code. Concrete choices already in use: `npm:ndjson`, `npm:ignore`,
  `jsr:@std/tar`, `jsr:@std/ulid`, `jsr:@db/sqlite`, `npm:hono`, `npm:zod`,
  `npm:openai`, `npm:kokoro-js`, `npm:@huggingface/transformers`,
  `jsr:@noble/ed25519`.

## After a Task

- Run `deno task check` to type-check everything (delegates to `deno check`
  - `svelte-check` via npm: + `cargo check`/`clippy`).
- Run `deno task fmt` to format (Deno fmt for TS/MD, Cargo fmt for Rust).
- Run `deno task lint` for lint (Deno lint + Cargo clippy).
- Run `deno task test` to run the test suite (Deno + vitest + cargo test). See
  "Testing" below for layout, tasks, and the agent scratch-test workflow.
- Run `deno task dev` to boot core + client together; manually exercise the
  feature in the running app. The core listens on `127.0.0.1:7800` by default;
  the client UI is at `http://localhost:1420` in dev.
- Review whether `README.md` and this file should be updated.

## Testing

Tests live co-located with source as `*.test.ts`. E2E specs live under
`tests/e2e/specs/` with their own runner (`deno task test:e2e`, opt-in).

| Pattern              | Where                     | Gitignored? | Run by                  |
| -------------------- | ------------------------- | ----------- | ----------------------- |
| `*.test.ts`          | co-located next to source | no          | `deno task test`        |
| `*.test.ts`          | `tests/e2e/specs/`        | no          | `deno task test:e2e`    |
| `*.tmp.test.{ts,rs}` | anywhere                  | **yes**     | same runner as siblings |

### Tasks

- `deno task test` — runs everything under `packages/**` (Deno + vitest +
  cargo).
- `deno task test:deno` — Deno only (core + shared + builtin-toolkit + updater).
- `deno task test:core` — just `tomat-core`.
- `deno task test:shared` — just `tomat-shared`.
- `deno task test:ui` — vitest against the Svelte UI.
- `deno task test:rs` — cargo test for both Rust crates.
- `deno task test:e2e` — WebdriverIO; manual only.

### Agent workflow for scratch tests

When developing a feature, agents are encouraged to create temporary tests for
their own exploration:

1. Create `foo.tmp.test.ts` next to the source.
2. Run via the normal task (`deno task test` / `test:ui` / `test:rs`).
3. Delete when the feature is done — or promote to a permanent test by removing
   the `.tmp` segment.

Scratch tests are gitignored via `**/*.tmp.test.{ts,rs}` in the repo root
`.gitignore`, so they never leak into commits or CI.

### Notes

- The Deno-side test harness lives in `packages/tomat-core/tests/helpers/`.
  `setupTestEnv()` creates a tempdir-isolated SQLite DB and resets every
  module-level singleton; use it from every test that touches DB or services.
- For Svelte 5 runes, drive `$effect` synchronously with `flushSync()` from
  `svelte` when asserting side effects.
- `tomat-core-keychain` exposes a `KeychainStore` trait + `InMemoryKeychain` so
  unit tests don't hit the real OS keychain (which would prompt the user on
  macOS / fail headless on Linux). The Tauri-side `commands/keychain.rs` uses
  the same pattern. `InMemoryKeychain` lives behind
  `#[cfg(any(test, feature
  = "in-memory"))]`; reverse-dependency tests must
  opt in via the feature.
- See `tests/README.md` for the full developer guide.

## Logging

- All `tomat-core` modules use the structured logger via `getLogger("scope")`
  from `src/shared/log.ts`. `console.log/warn/error` is forbidden except in the
  boot-failure catch in `main.ts` (where the logger may not yet be initialized).
- Every formatted line runs through `scrubSecrets` (also exported from
  `src/shared/log.ts`) which masks bearer tokens, admin-token values, and
  `?token=` URL parameters before the line reaches `core.log` or stderr. Tests
  live in `src/shared/log.test.ts`.

## General Rules

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style.
- If you notice unrelated dead code, mention it — don't delete it.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

## Distribution

Two hostnames, both Cloudflare-hosted:

- `au.tomat.ing` — Astro Worker (Static Assets). Serves `/`, `/manifests/*`,
  `/install/*`, `/schemas/*`. Defined as `CDN_BASE_URL` in
  `packages/tomat-core/src/config.ts`.
- `get.au.tomat.ing` — R2 public bucket (`tomat-releases`) attached as a custom
  domain. Serves `/<version>/<triple>/<file>` for compiled core binaries (direct
  fetch, no Worker in the path → free-tier). Defined as `RELEASES_BASE_URL` in
  the same config.

**Trust root**: signed manifests use Ed25519. The private key lives in `.env` at
the repo root (gitignored, auto-generated on first deploy); the public key is
written into `packages/tomat-core/data/signing-keys.json` (which IS committed —
public keys are not secret) and imported into the runtime via a typed JSON
import, so every compiled core trusts the matching signatures. One keypair signs
both `core.json` (self-update) and `binaries.json` (helper binaries).
`deno task website:deploy` is responsible for keeping `signing-keys.json` in
sync with `.env`.

**Deploy**: `deno task website:deploy` from the repo root runs the full pipeline
— keypair seed → core+updater builds for every Deno-supported triple → signed
`core.json` + signed `binaries.json` → Astro build → R2 upload →
`wrangler
deploy`. The helper-binary manifest (`binaries.json`) is composed from
`packages/tomat-website/data/upstream-binaries.json`, a hand-maintained config
of per-triple URL + sha256 entries for `llama-server`, `whisper-server`, and
`deno`; the referenced `.tar.gz` files must already live in R2 (or any
HTTPS-reachable origin) for installs to succeed. See
`packages/tomat-website/README.md` for one-time setup. Use
`deno task website:build` for a dry run (everything except the upload and worker
deploy) and `deno task website:dev` for an Astro dev server on the landing page
only.
