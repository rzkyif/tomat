# tomat-core-updater

Standalone Rust crate compiled to its own small binary (not a `deno compile`
entry), so the binary boundary is explicit and the artifact stays a few hundred
KB. It swaps a staged core build into place during self-update, then restarts
core. It runs as its own process so the swap survives the parent core exiting.
The header comment in [`src/main.rs`](src/main.rs) is the canonical deep doc;
this README stays short.

## Layout

A single [`src/main.rs`](src/main.rs) with co-located unit tests.

## Usage

```
tomat-core-updater --staged <path> --current <path> [--restart-args <json>]
```

Waits 2 seconds for the parent core process to exit, atomically renames
`--staged` over `--current` while preserving the previous binary as `<name>.old`
(core's boot-time rollback restores it if the new binary crash-loops, and
deletes it once the update is committed), then spawns the new core detached with
`--restart-args` forwarded as its argv. Exit codes: 0 success, 2 bad arguments,
3 Windows move-aside failed, 4 install rename failed, 5 spawn of the new core
failed. Logs to a per-channel `logs/updater.log`, mirroring WARN/ERROR to
stderr.

## Run, build, test

This crate exposes the standardized verbs as cargo wrappers (its `deno.json`):
`deno task check:core-updater`, `lint:core-updater`, `test:core-updater`,
`build:core-updater`, or `cd` in and run `deno task <verb>`. It is also compiled
as part of `deno task build:core` and folded into the repo-wide
`deno task check` / `lint` / `test`.

Invoked by core's self-updater; see
[`../tomat-core/src/update/README.md`](../tomat-core/src/update/README.md).
