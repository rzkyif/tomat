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
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

const args = parseArgs(Deno.args, {
  string: ["channel"],
  default: { channel: "stable" },
});

// The Android build (Gradle + cargo-ndk) needs ANDROID_HOME, an NDK path, and a
// JDK. Honor whatever the environment already sets; otherwise fall back to the
// standard macOS locations (Android Studio + its bundled JBR), so a local
// `deno task build:client:android` works out of the box on a stock mac setup
// without the user having to export anything. On other hosts, set these in env.
function resolveAndroidEnv(): Record<string, string> {
  const home = Deno.env.get("HOME") ?? "";
  const out: Record<string, string> = {};

  const androidHome =
    Deno.env.get("ANDROID_HOME") ??
    Deno.env.get("ANDROID_SDK_ROOT") ??
    join(home, "Library/Android/sdk");
  out.ANDROID_HOME = androidHome;
  out.ANDROID_SDK_ROOT = androidHome;

  let ndk = Deno.env.get("NDK_HOME") ?? Deno.env.get("ANDROID_NDK_HOME") ?? "";
  if (!ndk) {
    try {
      const ndkRoot = join(androidHome, "ndk");
      const versions = [...Deno.readDirSync(ndkRoot)]
        .filter((e) => e.isDirectory)
        .map((e) => e.name)
        .sort();
      if (versions.length > 0) ndk = join(ndkRoot, versions[versions.length - 1]);
    } catch {
      // no NDK dir; gradle will surface a clearer error than we can here
    }
  }
  if (ndk) {
    out.NDK_HOME = ndk;
    out.ANDROID_NDK_HOME = ndk;
  }

  let javaHome = Deno.env.get("JAVA_HOME") ?? "";
  if (!javaHome) {
    const jbr = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
    try {
      if (Deno.statSync(jbr).isDirectory) javaHome = jbr;
    } catch {
      // no Android Studio JBR; rely on a system JDK on PATH
    }
  }
  if (javaHome) out.JAVA_HOME = javaHome;

  return out;
}

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
  cwd: join(ROOT, "packages/tomat-client"),
  env: { ...Deno.env.toObject(), ...resolveAndroidEnv(), TOMAT_CHANNEL: channel },
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
