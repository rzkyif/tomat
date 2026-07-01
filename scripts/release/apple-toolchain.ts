// Apple build-toolchain resolution + availability, single-sourced so the iOS
// build entry (scripts/build-ios.ts), the release item (scripts/release/ios.ts),
// and the gate that decides whether a release includes the iOS client all agree
// on what "the toolchain is present" and "signing is configured" mean.
//
// iOS is Apple-only: xcodebuild cannot cross-compile or cross-sign off macOS, so
// every check returns false on a non-mac host. Signing + App Store upload reuse
// the same APPLE_* env already carried on DeployEnv for the macOS client (see
// lib.ts), so no new secrets are introduced.

import type { DeployEnv } from "./lib.ts";

/** Resolve the env a `tauri ios build` needs for signing. Tauri/xcodebuild read
 *  the development team from APPLE_DEVELOPMENT_TEAM (or bundle.iOS.developmentTeam
 *  in the config); the App Store Connect API key is passed to the upload step.
 *  Keys that could not be resolved are omitted, so callers can detect what is
 *  missing. Empty when no Apple env is set (the simulator/unsigned dev path). */
export function resolveAppleEnv(env: DeployEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.appleTeamId) out.APPLE_DEVELOPMENT_TEAM = env.appleTeamId;
  return out;
}

/** True when a real Apple **signing** identity is configured (a Team ID plus a
 *  certificate, either an installed identity or a base64 .p12 on CI). Without it
 *  only an unsigned simulator build is possible. */
export function hasAppleSigning(env: DeployEnv): boolean {
  return !!env.appleTeamId && (!!env.appleSigningIdentity || !!env.appleCertificateB64);
}

/** True when the App Store Connect API key trio is configured, so a signed .ipa
 *  can be uploaded to App Store Connect / TestFlight (the iOS distribution path;
 *  iOS has no R2 self-host). */
export function hasAppStoreConnectApi(env: DeployEnv): boolean {
  return !!env.appleApiKey && !!env.appleApiIssuer && !!env.appleApiKeyPath;
}

/** True when iOS can be both signed and shipped: the release orchestrator drops
 *  the iOS item (with a yellow warning) when this is false, exactly as it drops
 *  the desktop client without Tauri keys and android without a keystore. Until
 *  the Apple Developer account + secrets exist, this is false and iOS is inert. */
export function appleReleaseConfigured(env: DeployEnv): boolean {
  return hasAppleSigning(env) && hasAppStoreConnectApi(env);
}

function commandSucceeds(cmd: string, args: string[]): boolean {
  try {
    return new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).outputSync().success;
  } catch {
    return false;
  }
}

/** True when this host can build for iOS at all: macOS with a working xcodebuild
 *  and the aarch64-apple-ios rust target installed. Used to gate the iOS build
 *  and to fail fast off-mac with a clear message instead of a cryptic xcodebuild
 *  error. Does NOT imply signing is configured (see hasAppleSigning). */
export function iosToolchainReady(): boolean {
  if (Deno.build.os !== "darwin") return false;
  if (!commandSucceeds("xcodebuild", ["-version"])) return false;
  try {
    const out = new Deno.Command("rustup", {
      args: ["target", "list", "--installed"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return new TextDecoder().decode(out.stdout).includes("aarch64-apple-ios");
  } catch {
    // No rustup (a rustc-only toolchain); assume the target is available rather
    // than blocking the build over a probe we cannot run.
    return true;
  }
}
