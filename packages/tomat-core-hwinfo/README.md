# tomat-core-hwinfo

Standalone Rust crate compiled to its own small binary (not a `deno compile`
entry), so the binary boundary is explicit and the artifact stays a few
hundred KB. It reports total/available RAM, physical CPU cores, and the GPU
backend + VRAM (plus a unified-memory flag) as one JSON object on stdout,
feeding core's model fit engine. The header comment in
[`src/main.rs`](src/main.rs) is the canonical deep doc; this README stays
short.

## Layout

A single [`src/main.rs`](src/main.rs).

## Behavior

RAM and physical cores come from `sysinfo`. The GPU probe is per-platform: on
Apple Silicon the backend is `metal` with VRAM equal to system RAM and
`unifiedMemory: true` (name via `sysctl`); on Intel Macs `metal` with VRAM 0;
elsewhere it tries `nvidia-smi` (`cuda`) then `rocm-smi` (`rocm`). When no GPU
probe succeeds it degrades gracefully to the `cpu` backend, and the binary
never fails the caller (worst case it prints `{}`). JSON fields are camelCase
(`totalRamBytes`, `availableRamBytes`, `cpuCoresPhysical`, `gpu`,
`unifiedMemory`), matching the `HardwareInfo` shape core parses in
[`../tomat-core/src/models/hardware.ts`](../tomat-core/src/models/hardware.ts).

## Run, build, test

From the repo root: compiled as part of `deno task build:core`; `deno task
check` includes `cargo check` and `deno task lint` includes `cargo clippy`.
There is no test suite for this crate (it is not part of `deno task test:rs`).
