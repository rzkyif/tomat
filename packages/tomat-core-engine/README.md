# @tomat/core-engine

The runtime-agnostic heart of tomat-core. It owns the portable, stateful logic
(sessions/messages, chat orchestration + LLM streaming, settings, memories,
embedding/relevance, external STT/TTS, remote MCP) and exposes it behind a `Host`
abstraction, so the exact same TypeScript runs in two places:

- inside the Deno service (`@tomat/core`), which supplies a `DenoHost` (Deno FS,
  `@db/sqlite`, the OS keychain) and serves the engine over `Deno.serve`; and
- in a future pass, inside the mobile Client's webview, which will supply a
  webview host (Tauri FS, an in-webview SQLite, platform secure storage) and drive
  the engine in process.

## The boundary

The engine imports **no** `Deno.*`, `@db/sqlite`, `@tauri-apps/*`, or `node:*`,
and no subprocess/serve APIs. That purity is enforced by the `tomat/no-host-import`
oxlint rule (see [`.oxlintrc.json`](../../.oxlintrc.json) +
[`oxlint-plugin.ts`](../../scripts/lint-plugins/oxlint-plugin.ts)). Everything
runtime-specific is reached through the [`Host`](src/host.ts) the embedder injects
at [`init(host)`](src/engine.ts):

- `Host.fs` (async), `Host.openDb` (a synchronous SQLite subset), `Host.secureStore`
  (the vault master key), `Host.config` (env/config), `Host.log`, `Host.capabilities`.
- The embedder drives an [`EngineInstance`](src/engine.ts): `handleHttp(req)` for
  the whole `/api/v1/*` app surface (a runtime-agnostic Hono `app.fetch`), and
  `connect(clientId)` for WS-equivalent frame exchange over the
  [`FrameBus`](src/frame-bus.ts). Frame payloads are the `@tomat/shared` frame
  unions, so the wire contract matches the Client byte-for-byte.

Transport, TLS, pairing/auth, and every subprocess/native subsystem (sidecars,
binaries, self-update, the tool-worker sandbox, stdio MCP, helper binaries) stay
in `@tomat/core`, not here.

## Run / check / test

Standardized verbs (fanned out by `scripts/pkg.ts` from the root, or run in-dir):

```
deno task --cwd packages/tomat-core-engine check
deno task --cwd packages/tomat-core-engine test
```

Tests are co-located as `*.test.ts`, following the repo convention.
