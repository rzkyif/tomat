# E2E

E2E specs drive the real Tauri shell through `tauri-driver` and WebdriverIO.
They are NOT run in CI. Invoke them manually with `deno task test:e2e`.

## One-time setup

This toolchain is opt-in and isn't wired into the workspace `deno.json`.

```sh
# 1. tauri-driver supervises the platform WebDriver
cargo install tauri-driver --locked

# 2. Build a debug Tauri binary the harness can launch
deno task build:client

# 3. WDIO and friends live here rather than in the workspace deno.json,
#    so they don't get pulled into developer machines that never run E2E.
cd tests/e2e
npm init -y
npm i --save-dev \
  @wdio/cli@9 \
  @wdio/local-runner@9 \
  @wdio/mocha-framework@9 \
  @wdio/spec-reporter@9 \
  @types/mocha \
  webdriverio@9 \
  expect-webdriverio
cd ../..
```

Then verify the harness works:

```sh
deno task test:e2e
```

If `hello.test.ts` passes, the harness is good. Expand coverage from there.

## Platform notes

- **macOS**: `tauri-driver` historically had rough edges on recent macOS. As of
  darwin 25.4 / macOS 26 the support story is **unverified**. If `tauri-driver`
  fails to launch or fails to attach to the WebView, document the limitation
  here and rely on Svelte component tests via vitest plus manual
  `deno task dev` smoke tests until upstream catches up.
- **Linux**: usually the most reliable; uses `WebKitWebDriver` from webkit2gtk.
- **Windows**: requires `msedgedriver` matching the installed Edge WebView2
  version.

## Naming convention

Permanent specs are `*.test.ts`; agent scratch specs are `*.tmp.test.ts` and
gitignored. Both globs are picked up by `wdio.conf.ts`.

## What to write E2Es for

E2E is expensive and brittle. Reserve it for flows where the JS / Rust / OS
boundary is load-bearing AND the in-source tests can't prove the behavior:

- pairing handshake against a real installed core
- global shortcut registration
- file-to-markdown conversion with a real picker (only the picker dialog; the
  parsing layer is in-source)
- screen capture / region capture overlay

Everything else (the chat surface, settings, message rendering) should be
covered with vitest + `@testing-library/svelte` and a mocked `platform()`.
