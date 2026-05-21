<p align="center">
<img src="./packages/tomat-client/static/tomat.svg" width="100"/>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"/></a>
  <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-orange"/>
</p>

# tomat

A local-first modular AI client. **Tomat** runs the LLM, speech-to-text,
text-to-speech, and tool execution as a long-running service (`tomat-core`) that
can sit on the same machine as the UI or on a different one (e.g. your gaming
PC). The desktop client (`tomat-client`) is a small Svelte+Tauri app that talks
to one or more paired cores over an HTTP+WS API.

## Architecture at a glance

```
 ┌──────────────────────────────────────────┐
 │                tomat-client              │
 │  (Tauri+Svelte; window, capture, audio,  │
 │   VAD, global shortcuts, paired-cores UI)│
 └────────────────────┬─────────────────────┘
                      │ HTTP+WS (bearer)
                      ▼
 ┌──────────────────────────────────────────┐
 │                tomat-core                │
 │   (Deno service: sessions, chat, tools,  │
 │    TTS/STT, model/binary mgmt, pairing)  │
 └─────┬───────┬───────┬───────┬────────────┘
       │       │       │       │
llama-server  whisper-server  tts (Deno)  tool workers (Deno)
                                          (one per toolkit,
                                           permission-flagged)
```

**Packages:**

- `packages/tomat-shared/` — TypeScript types + Zod schemas (API contract,
  `tools.json` schema, WS frame discriminated unions).
- `packages/tomat-core/` — Deno service, single SQLite DB, all sidecar
  supervision, npm-based toolkit installation, in-process embeddings.
- `packages/tomat-client/` — Tauri 2 + Svelte 5 + Vite + UnoCSS desktop UI.

## Setup

### Prerequisites

- **Deno 2.7+** (`brew install deno` / `winget install DenoLand.Deno` / see
  https://deno.com/).
- **Rust toolchain** for building the Tauri shell (`rust-toolchain.toml` in the
  client crate pins the version).
- **Cargo + Tauri 2 prerequisites** — see
  https://v2.tauri.app/start/prerequisites/.

### First-time setup

```bash
deno install        # populates node_modules + warms the Deno npm cache
```

That single command resolves every npm dependency declared across the three
workspace members. There is no `npm install` / `bun install` / `pnpm install`
step; Deno owns dependency management.

### Development

```bash
deno task dev       # spawns core (deno --watch) + client (tauri dev) together
```

The core listens on `127.0.0.1:7800` and the client UI runs at
`http://localhost:1420`. Output from each is prefixed `[core]` / `[client]`.

### Type-check + format + lint

```bash
deno task check     # deno check + svelte-check + cargo check
deno task fmt       # deno fmt + oxfmt + cargo fmt
deno task lint      # deno lint + oxlint + cargo clippy
```

## Pairing the client with a core

1. Install `tomat-core` on the machine that will run inference (same machine for
   the simple case; a different one for the "gaming PC" case). The install
   script (TBD; lives under `scripts/install/`) prints a 6-digit pairing code on
   first run.
2. Open the client, paste the core's URL (e.g. `http://192.168.1.50:7800`) and
   the pairing code. The client receives a long-lived bearer token, stored in
   your OS keychain under the service `tomat-client`.

A single client can pair with multiple cores and switch between them via a
dropdown in Settings. A single core can serve multiple clients simultaneously —
sessions are owned by the client that created them and are invisible to other
paired clients.

## Toolkits

Toolkits are npm packages with a `tools.json` at their root (see
[`packages/tomat-shared/src/tools-json-schema.json`](packages/tomat-shared/src/tools-json-schema.json)).
The format is an open standard: any host that understands `tools.json` can load
them. Core discovers toolkits by searching npm for the `tools-available`
keyword. Each tool declares the OS-level permissions it needs (network hosts,
filesystem paths, executables, env vars, FFI, sys flags); the user grants
permissions per tool, and the worker subprocess is spawned with exactly the
matching Deno `--allow-*` flags.

## Status

Alpha. The backend (`tomat-core`) is complete end-to-end (REST + WS, chat
streaming with tool-call hops, persistence, NPM-based toolkit install, TTS
subprocess, Ed25519-verified manifest fetch). The CDN at `au.tomat.ing` hosts
the signed core manifest and install scripts; compiled binaries are served from
`get.au.tomat.ing` (R2 public bucket). `binariesManager` and `selfUpdater`
verify against the baked-in public key on every fetch. The client is wired
end-to-end against the new API surface.

## License

[AGPL-3.0](LICENSE).
