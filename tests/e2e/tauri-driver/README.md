# tauri-driver smoke lane

The thin **native** E2E lane: it drives the real Tauri shell through
`tauri-driver` and WebdriverIO. It exists to cover exactly what the headless
lane (`../headless/`) cannot: the native WebView engine, the Rust `net`
transport (reqwest/rustls SPKI pinning), and OS-native calls. Keep it a thin
smoke lane; happy-path product coverage lives in headless.

It is **opt-in** and **never runs in CI**. Invoke it manually with
`deno task test:e2e`. See [the lane index](../README.md) for how the two lanes
divide up.

## One-time setup

This toolchain is heavy and browser-automation-only, so its deps live here as a
local npm install rather than in the workspace `deno.json` (the same opt-in
model the headless lane uses). It is not pulled onto developer machines that
never run E2E.

```sh
# 1. tauri-driver supervises the platform WebDriver
cargo install tauri-driver --locked

# 2. Build a debug Tauri binary the harness can launch
deno task build:client

# 3. WDIO and friends, installed into this lane only
cd tests/e2e/tauri-driver
npm init -y
npm i --save-dev \
  @wdio/cli@9 \
  @wdio/local-runner@9 \
  @wdio/mocha-framework@9 \
  @wdio/spec-reporter@9 \
  @types/mocha \
  webdriverio@9 \
  expect-webdriverio
cd ../../..
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

E2E is expensive and brittle. Reserve this lane for flows where the JS / Rust /
OS boundary is load-bearing AND the in-source tests can't prove the behavior:

- pairing handshake against a real installed core
- global shortcut registration
- file-to-markdown conversion with a real picker (only the picker dialog; the
  parsing layer is in-source)
- screen capture / region capture overlay

Everything else (the chat surface, settings, message rendering) should be
covered with vitest + `@testing-library/svelte` and a mocked `platform()`, or by
the headless lane when the client/core wire is load-bearing.
