// Builds the three binaries that make up a tomat-core install for the
// requested host triple:
//
//   tomat-core           (Deno compile): the long-running service
//   tomat-core-updater   (Cargo build):  performs the swap during self-update
//   tomat-core-keychain  (Cargo build):  wraps the platform keychain
//
// Default target is the current host. Pass `--target=<triple>` to override.
// Cargo cross-compilation for non-host triples requires the matching Rust
// target installed (`rustup target add <triple>`); plain `cargo build`
// outputs only host artifacts.

import { parseArgs } from "jsr:@std/cli@^1.0.0/parse-args";

const ROOT = new URL("..", import.meta.url).pathname;

const args = parseArgs(Deno.args, {
  string: ["target", "out", "channel"],
  default: { out: "dist", channel: "stable" },
});

const target = args.target ?? Deno.build.target;
const outDir = `${ROOT}${args.out}/${target}`;

// Channel suffix on OUR binary names so a beta build (tomat-core-beta) can be
// installed alongside stable (tomat-core). Stable stays bare. Mirrors
// paths.ts channelSuffix() + channel.rs channel_suffix().
const channel = args.channel;
if (!["stable", "dev", "beta"].includes(channel)) {
  console.error(`invalid --channel: ${channel} (expected stable, dev, or beta)`);
  Deno.exit(1);
}
const suffix = channel === "stable" ? "" : `-${channel}`;

await Deno.mkdir(outDir, { recursive: true });

const isWindows = target.includes("windows");
const exe = isWindows ? ".exe" : "";

async function denoCompile(name: string, entry: string): Promise<void> {
  const outPath = `${outDir}/${name}${exe}`;
  console.log(`compiling ${name} -> ${outPath}`);
  const cmd = new Deno.Command("deno", {
    args: ["compile", "--allow-all", "--target", target, "--output", outPath, entry],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    console.error(`compile ${name} failed (exit ${code})`);
    Deno.exit(code);
  }
}

async function cargoBuild(crateDir: string, builtName: string, outName: string): Promise<void> {
  console.log(`cargo build ${builtName} (release) -> ${outDir}/${outName}${exe}`);
  const cargoArgs = [
    "build",
    "--release",
    "--manifest-path",
    `${ROOT}${crateDir}/Cargo.toml`,
    "--target",
    target,
  ];
  const cmd = new Deno.Command("cargo", {
    args: cargoArgs,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    console.error(`cargo build ${builtName} failed (exit ${code})`);
    Deno.exit(code);
  }
  const builtPath = `${ROOT}target/${target}/release/${builtName}${exe}`;
  const dstPath = `${outDir}/${outName}${exe}`;
  await Deno.copyFile(builtPath, dstPath);
}

await denoCompile(`tomat-core${suffix}`, `${ROOT}packages/tomat-core/src/main.ts`);
await cargoBuild(
  "packages/tomat-core-updater",
  "tomat-core-updater",
  `tomat-core-updater${suffix}`,
);
await cargoBuild(
  "packages/tomat-core-keychain",
  "tomat-core-keychain",
  `tomat-core-keychain${suffix}`,
);

console.log(`done. artifacts at ${outDir}`);
