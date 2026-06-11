# AGENTS.md

_Keep this file at altitude: a high-level overview, common conventions, and
important decisions only. Specifics (build/test commands, the persistence tree,
release mechanics, toolkit details) belong in the docs linked under "Pointers",
not here. When tempted to add something, prefer the canonical doc and link it._

## Project Overview

tomat is a local-first modular AI client split into a long-running service and a
thin desktop UI that talk over an HTTP+WS API, plus helper binaries, a bundled
toolkit, and a distribution website. The packages:

- **`@tomat/core`**: Deno service that owns every stateful and computational
  concern: session/message storage, LLM streaming, sandboxed tool execution,
  TTS/STT supervision, model + binary downloads, toolkit installation,
  embedding-based tool relevance, multi-client pairing auth, and self-update.
- **`@tomat/core-updater`**: standalone Rust binary (`tomat-core-updater`) that
  swaps in a staged core build during self-update, then restarts core.
- **`@tomat/core-keychain`**: standalone Rust binary (`tomat-core-keychain`)
  that reads/writes/deletes secrets in the OS keychain over a stdio protocol.
- **`@tomat/client`**: Tauri + Svelte desktop UI, intentionally "dumb": it
  renders, captures input, plays audio, manages global shortcuts, and talks to
  one or more paired cores.
- **`@tomat/shared`**: pure TypeScript types + Zod validators consumed by both
  sides: API contract, domain shapes, `tools.json` schema, WS frame unions.
- **`@tomat/builtin-toolkit`**: reference toolkit installed by default on a
  fresh core; doubles as the worked example for the `tools.json` format.
- **`@tomat/website`**: Astro static site for the landing page at
  `au.tomat.ing`.

**Tech stack:** Deno 2, Hono, and SQLite (`jsr:@db/sqlite`) for the core; Tauri
2, Svelte 5, Vite, and UnoCSS for the client. Deno-first workspace: no
`package.json`, no bun, no pnpm; the client invokes Vite and the Tauri CLI
through `npm:` specifiers from `deno task`.

**Key locations:**

- Domain types, the API contract, and the `tools.json` schema live in
  `packages/tomat-shared/src/`. When changing the wire format, update this
  package first.
- Core HTTP routes: `packages/tomat-core/src/http/routes/`. WS frames:
  `packages/tomat-shared/src/api/ws.ts`. Settings keys consumed by core are
  documented in the header of `packages/tomat-core/src/services/chat.ts`.
- Client API access: `packages/tomat-client/src/ui/lib/core/`.
  Platform-specific Tauri calls: `packages/tomat-client/src/ui/lib/platform/`.
- Toolkit author API: the Zod schema in
  `packages/tomat-shared/src/validation/tools-json.ts` and the published JSON
  Schema in `packages/tomat-shared/src/tools-json-schema.json`.

## Conventions

- **Tauri boundary (absolute rule):** nothing under
  `packages/tomat-client/src/ui/` outside `lib/platform/tauri.ts` may import
  from `@tauri-apps/*`. Add a method to the `Platform` interface in
  `lib/platform/index.ts`, implement it in `tauri.ts`, stub it in `web.ts`, then
  call `platform().<namespace>.<method>()`. Enforced by the
  `tomat/no-tauri-import` oxlint rule (`.ts`) and a `.svelte` grep pass, both in
  `deno task lint`.
- **File naming** follows each host language's idiom: TypeScript `kebab-case`,
  Svelte components `PascalCase`, Rust `snake_case`, folders `kebab-case`,
  `scripts/` `kebab-case`. A `*.test.ts` next to a `.svelte` component mirrors
  the component name (`Toggle.test.ts`); otherwise tests follow the TypeScript
  rule. Identifiers in code follow `camelCase`/`PascalCase` regardless of
  filename. Never rename a setting `id` string because a file was renamed: those
  strings are persisted on disk and on the wire.
- **No em dashes.** `deno task lint` rejects the em dash (U+2014) across the
  whole repo (code, comments, strings, Markdown, and every other tracked file).
  When flagged, reword so the sentence reads naturally rather than swapping in
  another symbol.
- **Brand is lowercase.** The product is always written lowercase **tomat**,
  even at the start of a sentence or heading. The thin vocabulary: `tomat` (the
  product), `tomat core` (the service), `tomat client` (the desktop UI), and
  `tomat built-in toolkit`. Hyphenated package names (`tomat-core`), the all-caps
  `TOMAT_*` env vars, and `au.tomat.ing` identifiers are separate tokens and keep
  their own casing. `deno task lint` rejects a capital-initial spelling repo-wide
  via the `tomat/no-uppercase-tomat` oxlint rule plus `check-uppercase-tomat.ts`
  (the same oxlint-rule-plus-walker pair as the em-dash ban).
- **Logging.** `tomat-core` modules log via `getLogger("scope")` from
  `src/shared/log.ts`; `console.*` is forbidden except the boot-failure catch in
  `main.ts`. Every line runs through `scrubSecrets` (same module) which masks
  tokens before they reach `core.log` or stderr.
- **Library reuse.** Prefer maintained npm/JSR packages over hand-rolled code.
- **Terminology.** Use one term per concept in user-facing copy (settings,
  labels, messages): **Thinking** (a model's internal reasoning, never
  "reasoning"); **Provider** with **Local** / **External**; **Context Window**;
  **CPU Threads**; **Toolkit** (a bundle) and **Tool** (one function);
  **Session** (a conversation); **Bubble** (a chat bubble); **Speech-to-Text**
  for the engine and **Voice Input** for the capture UX; **Snippet**; **Core**
  (the service) and **Client** (the app). Phrase settings the model only honors,
  not enforces, as requests ("the language the agent **should** reply in").

## Key Decisions

- **Channels and persistence.** All state lives under `~/.tomat/<channel>/`,
  where
  the channel (`stable` default, `dev`, `beta`) is selected by `TOMAT_CHANNEL`
  and resolved identically in core, client, and the install scripts. The one
  exception is `models/`, shared across channels at `~/.tomat/models` so
  multi-GB weights are not re-downloaded per channel. Keychain entries, default
  ports, and service labels are channel-namespaced so two channels can run at
  once. See [DEVELOPMENT.md](DEVELOPMENT.md) for the channel/port tables.
- **Trust root.** Release manifests are Ed25519-signed. The private key lives in
  a gitignored `.env`; the public key is committed in
  `packages/tomat-core/data/signing-keys.json` so every compiled core trusts the
  matching signatures. One keypair signs both `core.json` and `binaries.json`; a
  separate Tauri-format keypair signs `client.json` and the bundled installers.
- **Distribution split.** Two Cloudflare-hosted hostnames, aligned with content
  type: `au.tomat.ing` (Astro Worker, landing page only) and `get.au.tomat.ing`
  (R2 public bucket, every release artifact: installers, schemas, manifests,
  binaries). Both are defined in `packages/tomat-core/src/config.ts`.
- **Helper-binary boundary.** The updater and keychain helpers are standalone
  Rust crates compiled to their own small binaries (not `deno compile` entries)
  so the binary boundary is explicit and the artifacts stay a few hundred KB.

## Pointers

For anything beyond the above, the canonical docs are:

- Build / run / test commands, channels:
  [DEVELOPMENT.md](DEVELOPMENT.md)
- Per-package overview (layout, run/build/test, internals): the
  `packages/<name>/README.md` of the package in question. Subsystem deep
  dives are nested next to the code:
  `packages/tomat-core/src/{sidecars,toolkits,update}/README.md` and
  `packages/tomat-client/src/ui/lib/core/README.md`.
- Test-suite guide (layout, helpers, fixtures, scratch tests, CI):
  [tests/README.md](tests/README.md)
- Release + deploy, beta releases, Cloudflare + R2 setup:
  [packages/tomat-website/README.md](packages/tomat-website/README.md)
- Toolkit author API:
  [packages/tomat-builtin-toolkit/README.md](packages/tomat-builtin-toolkit/README.md)
- Settings system + copy and terminology guidelines:
  [packages/tomat-shared/src/domain/settings/README.md](packages/tomat-shared/src/domain/settings/README.md)

Tests are co-located with source as `*.test.ts`; scratch tests are
`*.tmp.test.ts` (gitignored anywhere). After a change, run `deno task check`,
`deno task fmt`, `deno task lint`, and `deno task test`.

## General Rules

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them. Don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style.
- If you notice unrelated dead code, mention it. Don't delete it.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified. For multi-step tasks, state a
brief plan with a verification check per step.
