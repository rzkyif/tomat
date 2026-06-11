# tomat-core-keychain

Standalone Rust crate compiled to its own small binary (not a `deno compile`
entry), so the binary boundary is explicit and the artifact stays a few
hundred KB. It reads/writes/deletes secrets in the OS keychain (macOS
Keychain, Linux libsecret via secret-service, Windows Credential Manager) over
a stdio protocol, so core shells out instead of binding native FFI. The header
comment in [`src/main.rs`](src/main.rs) is the canonical deep doc; this README
stays short.

## Layout

A single [`src/main.rs`](src/main.rs) with co-located unit tests.

## Usage

```
tomat-core-keychain get <service> <account>
tomat-core-keychain set <service> <account>
tomat-core-keychain delete <service> <account>
```

`get` prints the stored password to stdout with a single trailing newline;
exits 1 with `ENTRY_MISSING` on stderr when no entry exists. `set` reads the
password from stdin, all bytes untransformed (core writes a single line of
base64). `delete` is idempotent: exit 0 whether or not the entry existed. Any
other error exits 2 with a human-readable message on stderr. An opt-in
`in-memory` Cargo feature swaps in an in-memory store so tests can exercise
the stdio protocol without touching the real OS keychain.

## Run, build, test

From the repo root: compiled as part of `deno task build:core`; `deno task
check` includes `cargo check`; tested by `deno task test:rs`.

Called from
[`tomat-core/src/services/keychain.ts`](../tomat-core/src/services/keychain.ts).
