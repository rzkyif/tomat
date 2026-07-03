# macOS Developer ID signing + notarization

The release pipeline is already wired to sign + notarize the macOS Client bundle
with an Apple Developer ID Application certificate. It is **inert until the
`APPLE_*` vars in `.env` are filled**: with them empty (the default), the macOS
build keeps ad-hoc signing (`tauri.conf.json` `bundle.macOS.signingIdentity` is
`"-"`) and the install script strips the Gatekeeper quarantine xattr on the way
in. This doc is the checklist for turning on real signing once a certificate is
in hand.

## What is already plumbed (do not redo)

- `DeployEnv` carries the optional Apple fields, loaded from `.env`
  (`envFromDotEnv`) and from the process env on a CI runner (`envFromProcess`) in
  [lib.ts](lib.ts).
- [client.ts](client.ts) `buildClient` injects the `APPLE_*` env into the Tauri
  build subprocess **only for an `apple-darwin` target and only for non-empty
  fields** (`appleSigningEnv`), so a blank cert never reaches Tauri and no other
  platform is affected.
- [.env.example](../../.env.example) documents every var (the "Apple Developer ID
  (macOS, optional)" block).
- `hardenedRuntime` is already `true` (Tauri's default for `bundle.macOS`), which
  notarization requires. Do **not** re-add it as if it were missing.

macOS cannot be cross-signed (Apple's tooling + terms require a Mac), so signing
runs on the macOS host/runner that builds the bundle - the same host that already
builds the `apple-darwin` triples.

## Cert-ready checklist

1. **Obtain + install the certificate.** Enroll in the Apple Developer Program
   ($99/yr), create a **Developer ID Application** certificate, and install it
   into the login keychain of the macOS build machine. Note the identity string,
   e.g. `Developer ID Application: Your Name (TEAMID1234)`, and your Team ID.

2. **Fill `.env`** (see [.env.example](../../.env.example)):
   - `APPLE_SIGNING_IDENTITY` = the identity string above. Locally you can leave
     `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` blank and rely on the cert
     already in the login keychain.
   - Notarization: fill **either** the Apple ID trio (`APPLE_ID`,
     `APPLE_PASSWORD` (an app-specific password from appleid.apple.com, not your
     login password), `APPLE_TEAM_ID`) **or** the App Store Connect API key trio
     (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` pointing at the
     `.p8`). The API key is the better fit for CI. Do not fill both.

3. **Finalize `tauri.conf.json` `bundle.macOS`** (the one part this plan left
   untouched, because it can only be validated against a real notarization run):
   - Optionally set `signingIdentity` here instead of the env var (the env var
     overrides it, so either works; the env keeps it out of git).
   - Add an `entitlements` file if a notarization run reports one is needed. Start
     with **no** custom entitlements: the WKWebView runs its JIT out-of-process
     (in `com.apple.WebKit.WebContent`), so the host app usually does **not** need
     `com.apple.security.cs.allow-jit` or `allow-unsigned-executable-memory`, and
     `device.microphone` is a sandbox/App-Store entitlement that a non-sandboxed
     Developer ID build does not require. Add entitlements only if a real
     `notarytool` submission or launch failure proves one is missing - do not
     copy a speculative list in.
   - Set `providerShortName` only if the Apple ID belongs to multiple teams (it
     disambiguates which team notarizes).

4. **Ship a `.dmg`.** DONE: `"dmg"` is in `bundle.targets` in
   [tauri.conf.json](../../packages/tomat-client/src/tauri/tauri.conf.json), and
   `client.ts` harvests the `.dmg` into `client.json`'s `downloads` map for the
   website's direct-download CTA. With signing on, Tauri staples the notarization
   ticket to the bundle after a successful notarization; confirm `xcrun stapler
validate` passes on the `.app` inside the `.dmg`. Until signing is on, the
   `.dmg` still builds (unsigned) and the install flow strips the quarantine
   xattr.

5. **Wire CI secrets.** Add the `APPLE_*` vars as repo secrets that reach the
   **macOS build runner only** (mirroring how the Tauri/Android build-signing
   keys are scoped - never the publish job). See the required-secrets list in
   [packages/tomat-website/README.md](../../packages/tomat-website/README.md).

6. **Verify end to end** on a clean Mac (ideally a fresh user account):
   - Download the `.dmg` **via a browser** (so it gets the quarantine xattr the
     install script would otherwise strip) and confirm it opens with no Gatekeeper
     "unidentified developer" / "damaged" warning.
   - `spctl -a -vvv /Applications/tomat.app` reports `accepted` with
     `source=Notarized Developer ID`.
   - Grant microphone + screen-recording, trigger a self-update, and confirm the
     grants persist (a stable identity is the reason to sign beyond `.dmg`
     shipping; ad-hoc identities can re-prompt after each update).

## Core `.pkg` (uses the same Apple identity)

The standalone Core installer ([core-installers.ts](core-installers.ts))
`pkgbuild`s a component pkg whose postinstall runs `tomat-core install-service`.
When `APPLE_SIGNING_IDENTITY` is set it is `productsign`ed and, when the
notarization creds exist, `notarytool submit --wait` + `stapler staple` runs.
Inert (unsigned pkg) otherwise, exactly like the client `.dmg`.

## Windows Authenticode (separate identity, still DORMANT)

Independent of Apple. The client NSIS installer and the Core NSIS installer ship
unsigned until a Windows code-signing cert exists (that is why the install flow
strips Mark-of-the-Web). To turn it on, fill `WINDOWS_CERTIFICATE_THUMBPRINT` (a
cert in the runner's store) or `WINDOWS_SIGN_COMMAND` (e.g. an Azure Trusted
Signing invocation with `%1` for the file) in `.env` / repo secrets. `client.ts`
`injectWindowsSigning` patches `tauri.conf.json` for the client bundle;
`core-installers.ts` `signWindows` signs the Core installer. Both are inert when
the env is empty.

## iOS (plumbed, inert until the Apple account + `APPLE_*` exist)

The iOS Client is wired end to end and gated on the same Apple membership plus a
Mac + Xcode, exactly like the macOS signing above: the dev loop works today, and
the build + release paths self-skip until the `APPLE_*` env is filled.

- **What works now:** `deno task dev:ios` boots the dev Core and launches the app
  on the iOS Simulator (mirrors `dev:android`, clean Ctrl+C teardown included).
  `deno task --cwd packages/tomat-client init:ios` generates `gen/apple` (commit
  it as source, like `gen/android`). `deno task check:ios` compiles the shell for
  `aarch64-apple-ios`; the CI `ios` job runs the same check.
- **What is inert until the account exists:** `build:client:ios` falls back to an
  unsigned Simulator build without signing; `scripts/release/ios.ts` (`iosItem`,
  registered in `main.ts`) is dropped by `appleReleaseConfigured(env)` when the
  signing + App Store Connect env is absent. So iOS does not interfere with other
  development, the CI iOS jobs (the `ios` cross-compile check in `ci.yml` and the
  `.ipa` build on the release runner) are gated behind an **`IOS_ENABLED` repo
  variable** and stay skipped, consuming no macOS runner minutes. To activate
  iOS: set the `IOS_ENABLED` repo variable to `true` and fill `APPLE_TEAM_ID` + a
  certificate (`APPLE_SIGNING_IDENTITY` or the base64 `APPLE_CERTIFICATE`) + the
  `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` trio; the same paths
  then build/sign/upload the `.ipa` to App Store Connect. The remaining
  account-side steps are creating the App Store Connect app record and submitting
  for App Review.
- **Architecture constraint:** iOS cannot run a local Core (no persistent
  background service); the iOS Client pairs to a Core on another device only. The
  mobile platform impl
  ([mobile.ts](../../packages/tomat-client/src/ui/lib/platform/mobile.ts)) already
  returns false/null across the local-core surface, and `updater.check` returns
  null on iOS (the App Store owns updates; there is no OTA self-host).
- **Keychain is iOS-ready:** the Apple native keyring store is cfg-gated for
  `macos` + `ios`
  ([keychain.rs:82](../../packages/tomat-client/src/tauri/src/commands/keychain.rs#L82),
  and the same in the `tomat-core-keychain` helper).
- **`gen/apple` customizations** (hand-applied after `init:ios`, like the Android
  manifest edits): `Info.plist` usage strings (`NSMicrophoneUsageDescription`,
  `NSLocalNetworkUsageDescription`) + an App Transport Security
  `NSAllowsLocalNetworking` exception for the LAN/dev Core, and a channel xcconfig
  that suffixes the bundle id off `TOMAT_CHANNEL` (the iOS analogue of gradle's
  `applicationIdSuffix`).
- **Distribution:** App Store only (the DMA alternative-marketplace path still
  needs the membership and is EU-only). `iosItem` mirrors `androidItem` but
  uploads to App Store Connect instead of self-hosting on R2, and requires App
  Review.
