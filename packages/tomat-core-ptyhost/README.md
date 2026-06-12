# tomat-core-ptyhost

Standalone Rust crate compiled to its own small binary (not a `deno compile`
entry), so the binary boundary is explicit and the artifact stays a few
hundred KB. It spawns a Deno tool worker with stdin and stderr attached to a
pseudo-terminal, because Deno only shows its interactive permission prompt
when both of those streams are terminals. Core drives the prompt (and the
regular worker-protocol frames) through a small NDJSON control protocol on
the helper's own stdio. The header comment in [`src/main.rs`](src/main.rs) is
the canonical deep doc; this README stays short.

## Layout

A single [`src/main.rs`](src/main.rs) with co-located unit tests. Unix only:
on Windows the binary exits with a `fatal` event and core falls back to the
legacy `--no-prompt` spawn (a ConPTY backend can slot in behind the same
protocol later).

## Protocol

Control frames arrive one JSON object per line on stdin: `spawn` (exactly
once, first; carries cmd, args, the child's entire env, optional cwd),
`write` (base64 bytes for the PTY master: worker frames and prompt answers
alike), and `kill`. Events leave one JSON object per line on stderr: `pty`
(base64 PTY master output: worker stderr plus Deno prompt text), `exit`
(child exited; ptyhost mirrors the code), and `fatal`. The worker's stdout is
inherited, so the core<->worker NDJSON stream passes through untouched;
ptyhost never writes to its own stdout. The PTY slave runs in raw mode: no
echo back into the master stream, no canonical-mode line limit (protocol
frames can exceed it), no output post-processing.
