// Builds the Tauri client bundle for the requested channel.
//
// Channel handling:
//   - TOMAT_CHANNEL is set in the build env so `option_env!("TOMAT_CHANNEL")`
//     in channel.rs bakes the channel into the shipped bundle (its runtime
//     default → ~/.tomat/<channel>/client, tomat-client-<channel> keychain).
//   - For non-stable channels we pass a `tauri build --config <json>` override
//     so the app gets a distinct productName + bundle identifier + updater
//     endpoint, letting stable and latest coexist as separate installed apps.
//
// Delegates the actual build to the client package's `build` task.

import { parseArgs } from "@std/cli/parse-args";

const ROOT = new URL("..", import.meta.url).pathname;

// Must match the base tauri.conf.json updater host (stable's endpoint).
const STORAGE_BASE = "https://get.au.tomat.ing";

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
// stable instead of overwriting it. And a plain local build (no updater signing
// key in the env) turns off updater-artifact creation so Tauri doesn't try to
// sign the bundle and abort; the release path sets TAURI_SIGNING_PRIVATE_KEY and
// so keeps createUpdaterArtifacts on, still emitting the signed .sig client.json
// needs. Tauri deep-merges this over tauri.conf.json.
const override: Record<string, unknown> = {};
if (channel !== "stable") {
  override.productName = `tomat-${channel}`;
  override.identifier = `au.tomat.ing.${channel}`;
  override.plugins = {
    updater: {
      endpoints: [`${STORAGE_BASE}/manifests/${channel}/client.json`],
    },
  };
}
if (!Deno.env.get("TAURI_SIGNING_PRIVATE_KEY")) {
  override.bundle = { createUpdaterArtifacts: false };
}

// The `--config` override must reach the Tauri CLI itself (it accepts inline
// JSON). We invoke the CLI directly rather than via `deno task build`: routing
// through `deno task build -- --config <json>` makes Tauri treat `--config`
// as a cargo passthrough (everything after `--`), and cargo parses it as a TOML
// dotted-key expression and fails. Calling the CLI directly also sidesteps
// `deno task`'s own `--config` flag.
const tauriArgs = ["run", "-A", "npm:@tauri-apps/cli@^2", "build"];
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
