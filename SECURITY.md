# Security Policy

Tomat is a local-first desktop app: a Deno service (`tomat-core`) that owns all
state and compute, paired with a deliberately thin Tauri + Svelte client
(`tomat-client`), plus helper binaries, a bundled toolkit, and a Cloudflare/R2
distribution site. The interesting attack surface is binary and model
provenance, secret handling, the local HTTP/WS API, multi-client pairing auth,
and the third-party tool sandbox. This document describes the security posture,
the trust boundaries we rely on, and the limitations we knowingly accept.

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports. Instead,
email the maintainer at [security@au.tomat.ing](mailto:security@au.tomat.ing).
Include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce (or a proof-of-concept).
- The commit hash or release version you tested against.
- Any relevant platform details (OS, architecture).

You should expect an initial acknowledgement within seven days. We'll keep you
updated as a fix is developed, and credit you in the release notes if you'd
like.

## Threat model and trust boundaries

**Trusted.** We assume the following are not the attacker:

- The local user account, its filesystem, and the OS keychain.
- Our Ed25519 release signing key (and the Tauri/minisign client-update key).
- npm, GitHub, and the R2 origin reached over TLS.
- **Paired clients.** Pairing is the trust grant. A paired client is treated as
  an administrator of the core it paired with: it can read and write sessions,
  change any setting, run tools, and trigger updates. An action that requires
  pairing is therefore in-policy, not a vulnerability. The admin token is only
  needed to pair a _new_ client (mint a pairing code); paired clients never need
  it again.

**Defended against.** We do protect against:

1. **Unpaired network attackers.** Anyone who can reach the core but has not
   paired, especially when the core is bound beyond loopback.
2. **MITM on the local network.** The core speaks plaintext HTTP, so when bound
   to a non-loopback interface its traffic is exposed to the LAN.
3. **Honest mistakes** by trusted users (footguns, accidental destructive
   actions, secrets ending up where they need not).
4. **Third-party code and supply chain.** Malicious toolkit npm packages,
   tampered models or helper binaries, a compromised CDN, and prompt-injected
   model output that drives tool calls.

## Architecture trust map

**Pairing and authentication.** Devices pair with a short-lived code minted by
the admin-token-guarded `POST /pairing/codes`. The code grant is hardened
against an unpaired attacker: the per-IP rate limiter keys on the real socket
peer address (threaded from `Deno.serve`, not the spoofable `X-Forwarded-For`),
and every claim attempt (right or wrong) burns the outstanding code's attempt
budget and poisons it after a small number of tries. A successful claim mints a
32-byte bearer token, stored as a sha256 hash; the admin token is 128-bit, mode
`0600`, and compared in constant time. All HTTP routes require the bearer token
except `/health` and `/pairing/claim`; the WebSocket authenticates the bearer at
upgrade. Revoking or rotating a client force-closes its live WebSockets so a
removed device loses access immediately rather than at its next reconnect.

**HTTP and WebSocket surface.** CORS is origin-allowlisted (loopback plus the
Tauri origins); auth is header-based, so there is no CSRF vector. A global
request-body size limit bounds memory use. Error responses are run through the
same secret-scrubber as the logs before they cross the wire. On the WebSocket
control plane, `interrupt` / `tool.cancel` / `tool.askuser_response` are scoped
to the owning client, so one paired client cannot drive another's in-flight chat
or tool call.

**Secret handling.** External API keys live in an AES-GCM-256 vault
(`secrets.enc`) sealed with a master key in the OS keychain (or a `0600` file
fallback on headless Linux). The vault is **write-only over the API**: secret
values are never returned. `GET /settings` redacts secret-typed fields, and
`PATCH /settings` rejects them (they must go through the secrets endpoint). The
client shows a "saved" placeholder for configured keys and only transmits a new
value when the user edits the field.

**Settings.** `PATCH /settings` is validated against the shared schema: wrong
types are rejected (so a malformed value cannot break core or flow into a
sidecar argument), and external base-URL fields must be HTTPS or loopback HTTP.

**Binary, model, and self-update provenance.** The helper-binary manifest
(`binaries.json`) and the core self-update manifest (`core.json`) are
Ed25519-signed and verified at runtime against a public key compiled into the
core. The self-update verifier authenticates the **entire** manifest (version,
binaries, workers, and helpers), so a tampered manifest cannot inject attacker
worker scripts or helper binaries even though their hashes are self-referential.
The staged core binary is sha256-verified before the swap, and a downgrade guard
refuses older versions unless the operator opts in. Model weights downloaded
from HuggingFace are verified against HF's published sha256 (the LFS
`x-linked-etag`) when available.

**Tool sandbox.** Tools run in Deno subprocesses with `--no-prompt` and an
explicit `--allow-*` set. Each tool runs in its **own** worker keyed per
(toolkit, tool), so its permissions are exactly the grants for that one tool,
not the union of every enabled tool's grants. Every worker additionally gets
`--deny-read` / `--deny-write` on the core's secret material (`secrets.enc`,
`.master-key`, `.admin-token`, the SQLite DB), which Deno enforces over any
`--allow`, so even a tool granted a broad path like `$home` cannot reach the
vault. npm toolkit tarballs are integrity-checked (SRI sha512, falling back to
sha1) before extraction; extraction rejects path-traversal (zip-slip) and
symlink/hardlink entries; `deno install` runs with `--allow-scripts=false` so
npm lifecycle scripts never execute; tools install default-disabled and
ungranted; and worker stdout/stderr are size-capped.

**Sidecars.** `llama-server`, `whisper-server`, and the TTS worker are spawned
without a shell and inherit only an allowlist of OS-essential environment
variables (not the core's full environment, which can carry operator secrets
like `GITHUB_TOKEN`). The llama.cpp web UI is only enabled when the server binds
loopback, so it is never exposed on the network.

**Tauri client.** The webview loads only the bundled frontend (no remote-domain
IPC). The CSP forbids inline scripts. The single raw-HTML render path (assistant
markdown) is sanitized with DOMPurify against a tag/attribute allowlist, and
remote images are blocked by the CSP, so there is no XSS-to-exfiltration chain.
Links in rendered model output open in the system browser rather than navigating
the app webview, preventing in-frame phishing. Per-core bearer tokens live in
the OS keychain.

**Distribution.** The landing page ships HSTS, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, and a Content-Security-Policy. Release
artifacts are served from an R2 origin over TLS. Private signing keys stay in a
gitignored `.env`; only public keys are committed.

## Known limitations and accepted risks

- **Plaintext HTTP beyond loopback.** When `server.bindHost` is set to a LAN
  interface or `0.0.0.0`, the API (including bearer tokens and message content)
  crosses the network unencrypted. Core logs a warning when bound off loopback.
  We do not yet ship TLS: doing it well requires the client webview to trust a
  self-signed cert (OS trust-store install) or to route all traffic through the
  Rust side, both of which are larger changes. Cert-pinning at pair time is the
  intended future direction. Until then, only widen `server.bindHost` on a
  trusted network.
- **Paired clients are equal administrators.** There is no per-client role
  separation. Any paired client can reconfigure the core, trigger a self-update,
  or revoke another client (which cascade-deletes that client's data). This is
  by design under the trust model above; the destructive client actions in the
  UI are gated behind a confirmation to guard against honest mistakes.
- **Install scripts trust TLS, not the signature.** The `curl | bash` /
  `iwr | iex` installers verify each downloaded artifact's sha256 against the
  manifest, but they do not verify the manifest's Ed25519 signature (verifying
  Ed25519 in portable shell is brittle). Install-time provenance therefore rests
  on TLS to the R2 origin. Once installed, the running core enforces the
  signature on every subsequent update. The client bundle is minisign-verified
  by the Tauri updater for in-app updates.
- **Beta channel sidecar provenance.** On the beta channel, sidecar binaries
  resolve to the latest upstream GitHub release at runtime and are verified
  against GitHub's published sha256 over TLS, which is outside our Ed25519
  signature. Trust for beta sidecars shifts partly to GitHub and TLS. Stable
  pins URLs and hashes at release time.
- **Toolkits run third-party code.** A toolkit you install runs with the Deno
  permissions you grant it. Grant narrowly: a broad `read`/`write`/`run`/`ffi`
  grant is real capability (the vault is always denied, but a granted `$home`
  read still exposes the rest of your home directory). Tools are sandboxed
  per-tool, but a tool you grant network and run access can still act with those
  capabilities.
- **Defense-in-depth items not yet tightened.** The Tauri `connect-src` CSP
  still allows a broad `https:` (no live XSS chain makes this exploitable
  today), the `convert_file_to_markdown` command is not path-restricted, the fs
  capability spans `~/.tomat/**`, and the signed binary manifest does not yet
  bind the release channel or a monotonic timestamp (a downgrade/replay would
  require a compromised CDN or TLS MITM). These are tracked hardening items.

## Operator hardening

- Keep `server.bindHost` at `127.0.0.1` unless you specifically need LAN
  pairing, and only widen it on a network you trust.
- Grant toolkit permissions as narrowly as possible. Be especially cautious with
  `run`, `ffi`, and broad `read`/`write` paths.
- Back up `~/.tomat/<channel>/core/.master-key` if it exists (the
  keychain-sealed path needs no backup); losing it loses all stored secrets.
- Prefer the secrets vault over plaintext values in `settings.json` for API
  keys.
- Only pair devices you trust: pairing makes them administrators of the core.

## Scope

In-scope:

- The Tauri host (Rust) and its commands, capabilities, and CSP.
- The `tomat-core` Deno service and its HTTP and WebSocket surface.
- The binary and model download and verification flow (Ed25519-signed
  manifests).
- Secret handling (API keys in the vault / OS keychain).
- Pairing and authentication.
- The third-party tool sandbox.

Out of scope:

- Vulnerabilities in upstream `llama.cpp`, `whisper.cpp`, or `deno` binaries
  themselves. Report those upstream. (Their provenance and verification are
  in-scope.)
- Attacks that require an already-compromised local user account or OS keychain
  (we assume both are trusted).
- Actions available only to an already-paired client (paired clients are trusted
  administrators by design).

## Supported versions

The project has not yet made a stable release. All security fixes land on
`main`. Once a `1.0` is cut, we'll document a supported-versions table here.
