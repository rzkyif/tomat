# @tomat/core

The Deno service that owns every stateful and computational concern of tomat:
session/message storage, LLM streaming, sandboxed tool execution, TTS/STT
supervision, model and binary downloads, extension installation, embedding-based
tool relevance, multi-client pairing auth, and self-update. The client stays
thin; core does the work. It compiles to a single `tomat-core` binary that runs
as an auto-start service and serves one or more paired clients over HTTPS/WSS.

## Layout

- `src/main.ts`: entrypoint. Boot order: paths, logger, update-marker rollback
  check, DB open + migrate, HTTP + WS server.
- `src/config.ts`: bootstrap config and every hardcoded URL (manifest and
  download hostnames), so changing a hostname is a one-file edit.
- `src/paths.ts`: canonical filesystem layout. Per-channel state under
  `~/.tomat/<channel>/core`; models are shared at `~/.tomat/models`.
- `src/binaries/`: download, extract, and install platform binaries (llama.cpp,
  tomat-core-speech, helper binaries) from the signed runtime manifest.
- `src/db/`: single SQLite connection (WAL), `schema.sql`, and migrations.
- `src/downloads/`: centralized download manager. One active download at a time,
  persisted to the `downloads` table, resumable across restarts.
- `src/http/`: Hono app, auth/CORS/error middleware, and one route module per
  API area (sessions, models, extensions, settings, pairing, update, ...).
- `src/models/`: model listing/download/probe, hardware detection, and the fit
  engine that sizes local models to the device.
- `src/services/`: the domain services: chat orchestration, sessions store, LLM
  provider + scheduler, endpoint resolution, secrets vault, keychain wrapper,
  auth, TLS, embedding, tool filtering, title generation.
- `src/shared/`: logging, errors, hashing, IDs, filesystem safety.
- `src/sidecars/`: subprocess supervision for llama-server (chat + a second
  instance for embeddings) and the tomat-core-speech speech sidecar (STT + TTS).
- `src/extensions/`: extension install, registry, permission grants,
  content-hash verification, and the sandboxed tool worker pool.
- `src/update/`: self-update download/verify/stage and boot-time rollback.
- `src/workers/`: worker subprocess entrypoints (tool, TTS, embedding).
- `src/ws/`: per-client WebSocket hub; routes chat frames and pushes
  server-initiated frames.
- `data/signing-keys.json`: the committed Ed25519 public key every compiled core
  trusts for release manifests.

The settings keys core consumes are documented in the header of
[`src/services/chat.ts`](src/services/chat.ts).

Logging convention: modules log via `getLogger("scope")` from
[`src/shared/log.ts`](src/shared/log.ts); `console.*` is forbidden outside the
boot-failure catch in `main.ts`. Every line passes through `scrubSecrets`, so
tokens are masked before they reach `core.log` or stderr.

## Installing a release build on another device

To control a different machine, install `tomat-core` on it (the desktop client's
pairing screen links here). The installer is a single command:

```bash
# macOS / Linux
curl -fsSL https://get.au.tomat.ing/install/core.sh | bash

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "iwr -useb https://get.au.tomat.ing/install/core.ps1 | iex"
```

To install the latest channel alongside stable, pass `--latest` (or
`TOMAT_CHANNEL=latest`); it installs `tomat-core-latest`, a `tomat-core-latest`
service, and binds port 7810:

```bash
# macOS / Linux
curl -fsSL https://get.au.tomat.ing/install/core.sh | bash -s -- --latest
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "& { $env:TOMAT_CHANNEL='latest'; iwr -useb https://get.au.tomat.ing/install/core.ps1 | iex }"
```

The installer downloads the signed core manifest, verifies the binary's SHA-256,
installs an auto-start service (launchd / systemd-user / Task Scheduler), starts
the daemon, prompts for an admin password (entered twice), and prints a 6-digit
pairing code. Open the client, paste the core's URL (e.g.
`http://192.168.1.50:7800`) and the pairing code. The client receives a
long-lived bearer token, stored in the OS keychain under the service
`tomat-client`. The admin password lets an already-paired client mint more
pairing codes (and remove other devices) remotely, without reading the admin
token off the core's machine. A single client can pair with multiple cores and switch between
them via a dropdown in Settings. A single core can serve multiple clients
simultaneously. Sessions are owned by the client that created them and are
invisible to other paired clients.

## Secrets and the master key in dev

Core seals secrets (external API keys) in `secrets.enc` with a master key kept
in the OS keychain, falling back to a `chmod 600`
`~/.tomat/dev/core/.master-key` file when the keychain helper binary is not
built (the usual dev case). Deleting that file (or the keychain entry) while
keeping `secrets.enc` makes the stored secrets undecryptable: core logs a loud
warning at startup and reads fail with a clear "master key mismatch". Preserve
`~/.tomat/dev/core/.master-key` across rebuilds, or re-enter the secrets in
Settings. A full `deno task clean --dev-state` reset clears both together, so it
is unaffected.

## Run, build, test

All commands run from the repo root:

- `deno task dev`: run core from source with `--watch` on the dev channel.
- `deno task build:core` / `deno task build:core:stable`: compile the
  `tomat-core` binary; also compiles the `tomat-core-updater`,
  `tomat-core-keychain`, and `tomat-core-hwinfo` helper binaries.
- `deno task test:core` / `deno task check:core`: this package's tests /
  type-check.
- `deno task dev:core`: run just core in isolation (`deno task dev` also starts
  the client).

Channel and port tables live in [DEVELOPMENT.md](../../DEVELOPMENT.md).

## Further reading

- [`src/sidecars/README.md`](src/sidecars/README.md): subprocess supervision.
- [`src/extensions/README.md`](src/extensions/README.md): extension install and
  sandboxed execution.
- [`src/update/README.md`](src/update/README.md): self-update and rollback.
