// Builds the three binaries that make up a tomat-core install for the
// requested host triple:
//
//   tomat-core           (Deno compile) — the long-running service
//   tomat-core-updater   (Deno compile) — performs the swap during self-update
//   tomat-core-keychain  (Cargo build)  — wraps the platform keychain
//
// Default target is the current host. Pass `--target=<triple>` to override.
// Cargo cross-compilation for non-host triples requires the matching Rust
// target installed (`rustup target add <triple>`); plain `cargo build`
// outputs only host artifacts.

import { parseArgs } from "jsr:@std/cli@^1.0.0/parse-args";

const ROOT = new URL("..", import.meta.url).pathname;

const args = parseArgs(Deno.args, {
  string: ["target", "out"],
  default: { out: "dist" },
});

const target = args.target ?? Deno.build.target;
const outDir = `${ROOT}${args.out}/${target}`;

await Deno.mkdir(outDir, { recursive: true });

const isWindows = target.includes("windows");
const exe = isWindows ? ".exe" : "";

async function denoCompile(name: string, entry: string): Promise<void> {
  const outPath = `${outDir}/${name}${exe}`;
  console.log(`compiling ${name} -> ${outPath}`);
  const cmd = new Deno.Command("deno", {
    args: [
      "compile",
      "--allow-all",
      "--target",
      target,
      "--output",
      outPath,
      entry,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    console.error(`compile ${name} failed (exit ${code})`);
    Deno.exit(code);
  }
}

async function cargoBuild(crateDir: string, binName: string): Promise<void> {
  console.log(`cargo build ${binName} (release) -> ${outDir}/${binName}${exe}`);
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
    console.error(`cargo build ${binName} failed (exit ${code})`);
    Deno.exit(code);
  }
  const builtPath =
    `${ROOT}${crateDir}/target/${target}/release/${binName}${exe}`;
  const dstPath = `${outDir}/${binName}${exe}`;
  await Deno.copyFile(builtPath, dstPath);
}

await denoCompile("tomat-core", `${ROOT}packages/tomat-core/src/main.ts`);
await denoCompile(
  "tomat-core-updater",
  `${ROOT}packages/tomat-core-updater/src/main.ts`,
);
await cargoBuild("packages/tomat-core-keychain", "tomat-core-keychain");

console.log(`done. artifacts at ${outDir}`);
