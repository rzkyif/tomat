// Runs type-checks for the Deno + Svelte/TS side of the monorepo.
//  - `deno check` for shared + core + website scripts
//  - client package's own check task for the Svelte/TS side (svelte-check via npm:)
// Rust (`cargo check`) is handled by the `check:rs` task in the root deno.json.

const ROOT = new URL("..", import.meta.url).pathname;

type Step = { name: string; cwd?: string; cmd: string[] };

const steps: Step[] = [
  {
    name: "deno check (shared + core + scripts)",
    cmd: [
      "deno",
      "check",
      "packages/tomat-shared/src/index.ts",
      "packages/tomat-core/src/main.ts",
      "scripts/release/main.ts",
      "scripts/website/dev.ts",
      "scripts/website/build.ts",
    ],
  },
  {
    name: "client svelte-check",
    cwd: `${ROOT}packages/tomat-client`,
    cmd: ["deno", "task", "check"],
  },
];

let failed = 0;
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const cmd = new Deno.Command(step.cmd[0], {
    args: step.cmd.slice(1),
    cwd: step.cwd ?? ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    failed++;
    console.error(`!! ${step.name} failed (exit ${code})`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} step(s) failed.`);
  Deno.exit(1);
}
console.log("\nall checks passed.");
