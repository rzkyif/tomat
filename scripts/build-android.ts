// Builds the Tauri client as an Android APK for the requested channel.
//
// Channel handling mirrors build-client.ts:
//   - TOMAT_CHANNEL is set in the build env so `option_env!("TOMAT_CHANNEL")`
//     in channel.rs bakes the channel into the shipped APK (its runtime default
//     -> the channel's app-data dir, tomat-client-<channel> secret store).
//   - For non-stable channels we pass a `tauri android build --config <json>`
//     override so the app gets a distinct productName + bundle identifier
//     (the android applicationId), letting stable and latest install side by
//     side on one device.
//
// Distribution is self-hosted: the resulting APK is signed by gradle's
// signingConfigs (see gen/android/app/build.gradle.kts, fed by
// keystore.properties at A4) and published with an Ed25519-signed android.json
// by scripts/release/android.ts. The Tauri updater plugin is desktop-only and
// is not involved here, so there is no updater-endpoint override.

import { parseArgs } from "@std/cli/parse-args";

const ROOT = new URL("..", import.meta.url).pathname;

const args = parseArgs(Deno.args, {
  string: ["channel"],
  default: { channel: "stable" },
});

const channel = args.channel;
if (!["stable", "dev", "latest"].includes(channel)) {
  console.error(`invalid --channel: ${channel} (expected stable, dev, or latest)`);
  Deno.exit(1);
}

// Non-stable channels get a distinct app identity so they install alongside
// stable instead of overwriting it. Tauri deep-merges this over the base
// tauri.conf.json + tauri.android.conf.json.
const override: Record<string, unknown> = {};
if (channel !== "stable") {
  override.productName = `tomat-${channel}`;
  override.identifier = `au.tomat.ing.${channel}`;
}

// Invoke the Tauri CLI directly (not via `deno task ... --`) so `--config`
// reaches the CLI rather than being treated as a cargo passthrough; see the
// matching note in build-client.ts.
const tauriArgs = ["run", "-A", "npm:@tauri-apps/cli@^2", "android", "build", "--apk"];
if (Object.keys(override).length > 0) {
  tauriArgs.push("--config", JSON.stringify(override));
}

const cmd = new Deno.Command("deno", {
  args: tauriArgs,
  cwd: `${ROOT}packages/tomat-client`,
  env: { ...Deno.env.toObject(), TOMAT_CHANNEL: channel },
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
