# Security Policy

Thanks for taking the time to look at Tomat's security posture. This project is a local-first desktop app; the interesting attack surface is mostly around binary provenance, secret handling, and local IPC.

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports. Instead, email the maintainer at [security@au.tomat.ing](mailto:security@au.tomat.ing). Include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce (or a proof-of-concept).
- The commit hash or release version you tested against.
- Any relevant platform details (OS, architecture).

You should expect an initial acknowledgement within seven days. We'll keep you updated as a fix is developed, and credit you in the release notes if you'd like.

## Scope

In-scope:

- The Tauri host (Rust) and its commands.
- The Bun/Elysia sidecar and its HTTP surface.
- The fetch-required-files download and verification flow.
- Secret handling (API keys in OS keychain).
- Capability and CSP configuration.

Out of scope:

- Vulnerabilities in upstream `llama.cpp`, `whisper.cpp`, or `bun` binaries themselves. Report those upstream.
- Attacks that require an already-compromised local user account (we assume the local filesystem and keychain are trusted).

## Supported versions

The project has not yet made a stable release. All security fixes land on `main`. Once a `1.0` is cut, we'll document a supported-versions table here.
