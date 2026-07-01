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

4. **Ship a `.dmg`.** Add `"dmg"` to `bundle.targets` in
   [tauri.conf.json](../../packages/tomat-client/src/tauri/tauri.conf.json) so a
   signed, notarized disk image is produced for direct download (the current
   targets omit it). Tauri staples the notarization ticket to the bundle after a
   successful notarization; confirm `xcrun stapler validate` passes on the `.app`
   inside the `.dmg`.

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

## Future iOS (deferred - captured here to avoid re-derivation)

An iOS Client is net-new and gated on the same Apple membership plus a Mac +
Xcode. Key facts already established, so the iOS agent does not have to
rediscover them:

- **Architecture constraint:** iOS cannot run a local Core (no persistent
  background service). The iOS Client pairs to a Core on another device only.
  This is already reflected in the mobile platform impl
  ([mobile.ts](../../packages/tomat-client/src/ui/lib/platform/mobile.ts)), where
  the local-core surface returns false/null and features are remote-only.
- **Keychain is already iOS-ready:** the Apple native keyring store is cfg-gated
  for `macos` + `ios`
  ([keychain.rs:82](../../packages/tomat-client/src/tauri/src/commands/keychain.rs#L82),
  and the same in the `tomat-core-keychain` helper).
- **No Xcode project exists:** there is no `gen/apple` (only `gen/android`).
  `tauri ios init` generates it. iOS shares the `run_mobile()` entry point and the
  Android-centric mobile stubs, so the iOS-specific gaps are: hardware back-button
  handling (Android hard-key at mobile.ts is not applicable; iOS needs an edge
  swipe/gesture), the hardcoded font list, and iOS `Info.plist` usage strings +
  distribution entitlements (all Xcode/cert-dependent).
- **Distribution:** App Store only (the DMA alternative-marketplace path still
  needs the $99 membership and is EU-only). A future `iosItem` release item would
  mirror `androidItem` but upload to App Store Connect instead of self-hosting on
  R2, and requires App Review.
