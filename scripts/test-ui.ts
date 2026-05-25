// Runs vitest against tomat-client's Svelte UI suite.
//
// Why a script instead of `deno run npm:vitest`: when vitest is launched
// through Deno's npm shim, the Vite plugin graph it loads (Svelte 5
// compiler, @testing-library/svelte runtime) sees Deno's npm resolver
// rather than Node's, and the Svelte compiler ends up being resolved
// twice — once for vitest's internal Vite and once for the test file
// graph. That mismatch surfaces as "cannot find Svelte 5 compiler" or
// "two copies of svelte loaded." Invoking the workspace's
// node_modules/.bin/vitest directly avoids the issue: it runs under
// plain Node and uses Node's resolution from start to finish.
//
// First-time setup: run `deno install` from the repo root once so
// nodeModulesDir: "auto" populates node_modules/.bin/vitest.

import { join } from "jsr:@std/path@^1";

const repoRoot = new URL("..", import.meta.url).pathname;
const vitestBin = join(repoRoot, "node_modules", ".bin", "vitest");
const clientDir = join(repoRoot, "packages", "tomat-client");

try {
  await Deno.stat(vitestBin);
} catch {
  console.error(
    `vitest binary not found at ${vitestBin}.\n` +
      `Run \`deno install\` from the repo root to populate node_modules.`,
  );
  Deno.exit(2);
}

// `vitest run` is the non-watch one-shot mode used by CI and by the
// agent workflow. Pass through extra args so `deno task test:ui --reporter=verbose`
// works.
const args = Deno.args.length > 0 ? Deno.args : ["run"];

const cmd = new Deno.Command(vitestBin, {
  args,
  cwd: clientDir,
  stdout: "inherit",
  stderr: "inherit",
});
const status = await cmd.output();
Deno.exit(status.code);
