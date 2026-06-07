// Builds the Tauri client bundle for the requested channel.
//
// Channel handling:
//   - TOMAT_CHANNEL is set in the build env so `option_env!("TOMAT_CHANNEL")`
//     in channel.rs bakes the channel into the shipped bundle (its runtime
//     default → ~/.tomat/<channel>/client, tomat-client-<channel> keychain).
//   - For non-stable channels we pass a `tauri build --config <json>` override
//     so the app gets a distinct productName + bundle identifier + updater
//     endpoint, letting stable and beta coexist as separate installed apps.
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
if (!["stable", "dev", "beta"].includes(channel)) {
  console.error(`invalid --channel: ${channel} (expected stable, dev, or beta)`);
  Deno.exit(1);
}

// Non-stable channels get a distinct app identity so they install alongside
// stable instead of overwriting it. Tauri merges this over tauri.conf.json.
const passthrough: string[] = [];
if (channel !== "stable") {
  const override = {
    productName: `tomat-${channel}`,
    identifier: `au.tomat.ing.${channel}`,
    plugins: {
      updater: {
        endpoints: [`${STORAGE_BASE}/manifests/${channel}/client.json`],
      },
    },
  };
  passthrough.push("--", "--config", JSON.stringify(override));
}

const cmd = new Deno.Command("deno", {
  args: ["task", "build", ...passthrough],
  cwd: `${ROOT}packages/tomat-client`,
  env: { ...Deno.env.toObject(), TOMAT_CHANNEL: channel },
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
