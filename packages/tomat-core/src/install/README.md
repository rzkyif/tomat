# install/ - core self-install & self-uninstall

The core binary is the single source of truth for installing and removing
itself. `main.ts` dispatches an install subcommand (via `cli.ts`) before booting
the server, so the core binary doubles as its own installer CLI. Every installer
front-end wraps these subcommands instead of re-implementing service
registration, secret bootstrap, and pairing:

- the native package post-install hooks (macOS `.pkg`, Windows Core NSIS, Linux
  `.deb`/`.rpm`),
- the client's in-app "set up a local Core" flow
  (`tomat-client/.../commands/pairing.rs`),
- the thin `scripts/install/core.{sh,ps1}` headless bootstrappers.

This replaces the ~1400-line `core.sh` / `core.ps1` that used to duplicate this
logic in shell + PowerShell (and where the PowerShell path skipped Ed25519
verification). Now verification runs once, here, in TypeScript.

## Subcommands (argv to the core binary)

| Verb                  | Does                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `self-install`        | Fetch + verify + place the binary set from the signed `core.json`. Reuses `update/self-updater.ts`'s `fetchCoreManifest` (Ed25519) + `downloadAndVerify` (gzip + streaming sha256). Leaves the running core binary in place.                                                                                                   |
| `bootstrap`           | Ensure the dir tree, mint the `.admin-token` (0600 / owner-only ACL), optionally seed `server.bindHost=0.0.0.0` (`--bind-all` / `TOMAT_INSTALL_BIND_ALL=1`) and/or `server.behindProxy=true` (`--behind-proxy` / `TOMAT_INSTALL_BEHIND_PROXY=1`), and plant the built-in extension for offline first-boot seeding. Idempotent. |
| `install-service`     | `bootstrap`, then register + start the OS service.                                                                                                                                                                                                                                                                             |
| `mint-code`           | Wait for the daemon to bind, mint a pairing code with the admin token, print one JSON line `{ code, url, port }` on stdout.                                                                                                                                                                                                    |
| `uninstall-service`   | Stop + remove the service, kill stragglers, clear the keychain master key, remove `~/.tomat/<channel>/core` (unless `--keep-data`). Preserves the shared `~/.tomat/models`.                                                                                                                                                    |
| `enable-behind-proxy` | Merge `server.behindProxy=true` into an existing `settings.json` and restart the daemon so it takes effect. The client's "install, pair, then flip" flow calls this AFTER the loopback pair (a proxy-served core folds no cert pin, so it cannot be paired over loopback). `TOMAT_INSTALL_SERVICE` selects the restart path.   |

Env: `TOMAT_CHANNEL` (channel selection, via `paths.ts`), `TOMAT_INSTALL_SERVICE`
(`0` = background launch, no service; also selects the `enable-behind-proxy`
restart path), `TOMAT_INSTALL_BIND_ALL`, `TOMAT_INSTALL_BEHIND_PROXY` (`1` = seed
`server.behindProxy=true` so pairing trusts an HTTPS proxy's certificate instead
of pinning; set before first pair).

## Per-OS service registration

Mirrors what the scripts did, namespaced per channel (`channelSuffix()`), with
`TOMAT_CHANNEL` baked into the service environment:

- **macOS** - user LaunchAgent `~/Library/LaunchAgents/au.tomat.core<suffix>.plist`
  (`RunAtLoad` + `KeepAlive`), `launchctl load`.
- **Linux** - systemd **user** unit
  `~/.config/systemd/user/tomat-core<suffix>.service` (`enable --now`), with a
  `nohup` fallback when `systemd --user` is unavailable.
- **Windows** - Task Scheduler `-AtLogOn` task `tomat-core<suffix>` (registered
  via PowerShell, matching `core.ps1`); non-stable channels wrap the launch in
  `cmd.exe` to set `TOMAT_CHANNEL` (scheduled tasks have no environment field).
  Windows installs (service or background) also register a per-user
  Add/Remove Programs entry (`HKCU\...\Uninstall\tomat-core<suffix>`, display
  name "tomat Core (<channel>)") whose uninstall command runs
  `uninstall-service` and then sweeps the core dir; `uninstall-service` removes
  the entry.

`TOMAT_INSTALL_SERVICE=0` skips the service and launches core in the background
(the client then owns liveness).

## Loopback trust for `mint-code`

Core writes its self-signed public cert (no key) to `paths().tlsCertFile` at boot
(`main.ts`). `mint-code`, a separate short-lived process, reads that PEM and
trusts it as a CA-of-one so it can talk to the loopback HTTPS API without
disabling TLS verification (the old script used `curl -k`). The client still pins
the SPKI at pairing; this file is public material regenerated each boot.

## Testing

`cli.test.ts` runs `bootstrap` against a temp `TOMAT_CORE_HOME` on the dev
channel (which skips the network extension plant), asserting token minting,
permissions, idempotence, and the bind-all seed - no service registration or
network. Service registration + pairing are exercised end-to-end per OS.
