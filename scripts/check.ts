// Type-checks the repo's root-level tooling scripts (release, website, and the
// package dispatcher). Per-package type-checks live in each package's own
// `check` task and are fanned out by scripts/pkg.ts.

const ROOT = new URL("..", import.meta.url).pathname;

const cmd = new Deno.Command("deno", {
  args: [
    "check",
    "scripts/release/main.ts",
    "scripts/website/dev.ts",
    "scripts/website/build.ts",
    "scripts/pkg.ts",
    "scripts/fmt-web.ts",
  ],
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
if (code !== 0) {
  console.error("!! root script type-check failed");
  Deno.exit(1);
}
console.log("root scripts type-checked.");
