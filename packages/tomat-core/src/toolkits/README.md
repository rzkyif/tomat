# Toolkits (core side)

How core installs, registers, trusts, and executes toolkits. The `tools.json`
format and everything a toolkit author needs live in
[the built-in toolkit README](../../../tomat-builtin-toolkit/README.md); this
document only covers the host machinery.

## Two-phase install ([`installer.ts`](installer.ts))

Both phases are explicit user actions:

- **Download** (`startDownload`): acquire the files (fetch + extract an npm
  tarball, copy a local folder, or resolve the built-in's bytes), validate
  `tools.json`, and upsert toolkit/tool rows at status `downloaded`. The folder
  stays byte-identical to what was downloaded; `deno.json` is never edited and
  the content hash is left unpinned.
- **Install** (`startInstallDeps`): run `deno install` for declared deps (with
  `DENO_DIR=~/.tomat/core/deno-cache` and `--node-modules-dir=auto`, so
  everything lands under `~/.tomat/`), pin the content hash, and flip the row to
  status `installed`.

`startUpdate` chains both under one job, and the install path re-pins the hash
so a legitimate update never reads as drift. Callers pass an `InstallEventSink`
to receive `install_log` and `install_done` frames for forwarding to the
requesting client over WS. [`uninstall.ts`](uninstall.ts) is the inverse: delete
drops rows and files; uninstall reverts a deps-bearing toolkit to `downloaded`
by removing `node_modules` and `deno.lock` only.

## Discovery and registry

npm discovery ([`npm-registry.ts`](npm-registry.ts)) searches for packages
carrying the `tools-available` keyword and resolves `package@version` to a
tarball URL; downloads are verified against npm's strong `dist.integrity` (SRI)
hash, not the legacy sha1 shasum, before extraction. The DB-backed registry
([`registry.ts`](registry.ts)) aggregates the `toolkits`, `tools`,
`tool_embeddings`, and `grants` tables and owns drift handling:
`verifyHashFresh` re-checks a toolkit's content hash at tool-call time (cheap
via a stat-signature skip-cache), and on mismatch flips the toolkit to status
`drift`, disables all its tools, and throws; only an explicit user re-enable
clears it.

## Trust anchor ([`hash.ts`](hash.ts))

The content hash is a deterministic SHA-256 over the toolkit folder: walk,
exclude `node_modules` and the root `deno.lock` (generated after pinning, so
including them would read install churn as tampering), apply `.gitignore` rules
(the `.gitignore` file itself stays included), sort paths, and hash
`path\0size\0content` per file. The `deno.json` the deps derive from IS hashed,
so tampering with declared imports is still detected.

## Least-privilege execution

[`validate-args.ts`](validate-args.ts) first validates LLM-emitted arguments
against the tool's JSON-Schema `parameters` with Ajv (filling defaults and
stripping catastrophic-backtracking regexes before they can compile).
[`permissions.ts`](permissions.ts) then maps granted permission declarations to
exact Deno `--allow-*` flags, expanding path templates (`$home`, `$downloads`,
`$models`, `$sessions`, `$toolkit`, `$env.VAR`). Workers are keyed per (toolkit,
tool), so a process holds ONLY the invoked tool's grants, never a sibling tool's
net/run/ffi access. The pool ([`worker-pool.ts`](worker-pool.ts)) keeps workers
warm with LRU eviction and an idle timeout (defaults: 8 warm workers, 5 min
idle, 60 s call timeout, paused while an `askUser` question is pending).
[`worker-handle.ts`](worker-handle.ts) owns one subprocess and its NDJSON
channel ([`worker-protocol.ts`](worker-protocol.ts)): frames cover boot, call,
cancel, progress, `askUser` request/response, log, and `stderr_log`; stdout
frames are capped at 16 MB and stderr lines at 1 MB so a runaway tool cannot
exhaust core's memory. The worker env is cleared and rebuilt from a small
operational allowlist plus explicitly granted env keys.

## Built-in toolkit seeding

The built-in toolkit is CDN-distributed (never on npm) behind an Ed25519-signed
manifest ([`builtin-manifest.ts`](builtin-manifest.ts)), mirroring the binaries
manifest; dev runs from the in-repo codebase instead. On first boot,
[`builtin-seed.ts`](builtin-seed.ts) downloads it (preferring
install-script-placed files) and leaves it at status `downloaded` with no
grants: Install, trusting, and per-tool Enable stay explicit user steps. A
sparse `toolkits.builtinSeeded` core setting records the seed so a user-deleted
built-in does not come back on the next boot.
