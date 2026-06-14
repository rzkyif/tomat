// Removes build artifacts. Explicit allowlist only. Never a glob walk and
// never `git clean` (which would also wipe gitignored secrets like .env).
//
//   deno task clean                build outputs (dist, target, .svelte-kit, …)
//   deno task clean --deep         also node_modules + the Deno cache
//   deno task clean --dev-state    also ~/.tomat/dev (isolated dev channel only)
//   deno task clean --latest-state   also ~/.tomat/latest (isolated latest channel only)
//
// `--dev-state` / `--latest-state` only ever touch that channel's ~/.tomat/<ch>
// subtree; a stable install (~/.tomat/stable) and the shared ~/.tomat/models
// are never removed. Channel state nests our binaries by suffix
// (tomat-core-latest), so build outputs in dist/ never need a per-channel clean.

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname;

// Build outputs, relative to the repo root. Every entry is gitignored.
const ARTIFACTS = [
  "dist",
  "packages/tomat-website/dist",
  "packages/tomat-website/.astro",
  "packages/tomat-website/.wrangler",
  "packages/tomat-client/build",
  "packages/tomat-client/.svelte-kit",
  "target",
];

// Removed only with --deep; re-run `deno install` afterwards.
const DEEP = ["node_modules", ".deno-cache"];

function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error("could not determine home directory (no HOME or USERPROFILE)");
  }
  return home;
}

async function rm(absPath: string, label: string): Promise<void> {
  try {
    await Deno.remove(absPath, { recursive: true });
    console.log(`removed  ${label}`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`skip     ${label} (absent)`);
    } else if (err instanceof Deno.errors.PermissionDenied) {
      console.warn(
        `WARN     ${label}: permission denied. Close your editor / stop cargo, then retry`,
      );
    } else {
      throw err;
    }
  }
}

const args = parseArgs(Deno.args, {
  boolean: ["deep", "dev-state", "latest-state"],
});

const targets: Array<{ path: string; label: string }> = ARTIFACTS.map((p) => ({
  path: join(ROOT, p),
  label: p,
}));

if (args.deep) {
  for (const p of DEEP) targets.push({ path: join(ROOT, p), label: p });
}

if (args["dev-state"]) {
  const devDir = join(homeDir(), ".tomat", "dev");
  targets.push({ path: devDir, label: "~/.tomat/dev" });
}

if (args["latest-state"]) {
  const latestDir = join(homeDir(), ".tomat", "latest");
  targets.push({ path: latestDir, label: "~/.tomat/latest" });
}

for (const { path, label } of targets) {
  await rm(path, label);
}
