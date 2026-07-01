// Builds the Tauri client for iOS for the requested channel.
//
// Channel handling mirrors build-android.ts:
//   - TOMAT_CHANNEL is set in the build env so `option_env!("TOMAT_CHANNEL")`
//     in channel.rs bakes the channel into the shipped app (its runtime default
//     -> the channel's app-data dir, tomat-client-<channel> secret store).
//   - For non-stable channels we pass a `--config` override for a distinct
//     productName (the on-device app label). The distinct bundle identifier that
//     lets stable + latest install side by side is applied by an xcconfig keyed
//     off TOMAT_CHANNEL in gen/apple (the iOS analogue of gradle's
//     applicationIdSuffix), NOT by overriding the Tauri `identifier`: the
//     identifier drives the generated Xcode project's PRODUCT_BUNDLE_IDENTIFIER
//     and target references, fixed at `tauri ios init` time, so overriding it
//     makes xcodebuild look for a target that does not exist (same reasoning as
//     Android).
//
// Distribution is App Store only (iOS cannot sideload a signed .ipa the way
// Android installs an APK), so there is no self-hosted manifest and no updater
// endpoint. When Apple signing is configured this builds a signed .ipa for App
// Store Connect; without it, it falls back to an unsigned Simulator build so
// local iteration still works without an Apple Developer account. iOS is
// macOS-only; off a mac the task self-skips.

import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl, join } from "@std/path";
import { iosToolchainReady } from "./release/apple-toolchain.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

const args = parseArgs(Deno.args, {
  string: ["channel"],
  default: { channel: "stable" },
});

const channel = args.channel;
if (!["stable", "dev", "latest"].includes(channel)) {
  console.error(`invalid --channel: ${channel} (expected stable, dev, or latest)`);
  Deno.exit(1);
}

if (!iosToolchainReady()) {
  console.error(
    "iOS builds require macOS with Xcode and the aarch64-apple-ios rust target; " +
      "skipping the iOS build on this host.",
  );
  Deno.exit(0);
}

// A real signing identity (Team ID + a certificate) is needed for a device/App
// Store .ipa. Without it we can still produce an unsigned Simulator build.
const team = Deno.env.get("APPLE_TEAM_ID");
const hasSigning =
  !!team && (!!Deno.env.get("APPLE_SIGNING_IDENTITY") || !!Deno.env.get("APPLE_CERTIFICATE"));

// Non-stable channels get a distinct on-device label so they read as separate
// apps; the distinct bundle id (for side-by-side install) is added by the
// channel xcconfig. We deliberately do NOT override `identifier` here (see the
// header note). Tauri deep-merges this over tauri.conf.json + tauri.ios.conf.json.
const override: Record<string, unknown> = {};
if (channel !== "stable") {
  override.productName = `tomat-${channel}`;
}

const tauriArgs = ["run", "-A", "npm:@tauri-apps/cli@^2", "ios", "build"];
if (hasSigning) {
  // A signed archive exported for App Store Connect / TestFlight.
  tauriArgs.push("--export-method", "app-store-connect");
} else {
  // No Apple signing configured: build for the Simulator so the task still
  // produces a runnable artifact without an Apple Developer account.
  console.error(
    "APPLE_TEAM_ID / signing not set; building an unsigned Simulator app " +
      "(a signed .ipa needs an Apple Developer account).",
  );
  tauriArgs.push("--target", "aarch64-sim");
}
if (Object.keys(override).length > 0) {
  tauriArgs.push("--config", JSON.stringify(override));
}

const cmd = new Deno.Command("deno", {
  args: tauriArgs,
  cwd: join(ROOT, "packages/tomat-client"),
  env: {
    ...Deno.env.toObject(),
    TOMAT_CHANNEL: channel,
    ...(team ? { APPLE_DEVELOPMENT_TEAM: team } : {}),
  },
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
