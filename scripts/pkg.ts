// Fans a standardized verb (check, lint, fmt, fmt:check, test, build, ...) out
// across the workspace members that define it, reading the package list from the
// root `deno.json` `workspace` array (the single source of truth for packages).
//
// Each member is run in isolation via its own `deno task`, so the root's
// same-named aggregate is never re-entered (a `deno task -r <verb>` / glob
// `--filter` would also run the root task and recurse). Per-package tasks live
// in each package's `deno.json`; this script is only the fan-out.
//
// Usage: deno run -A scripts/pkg.ts <verb>

import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

const verb = Deno.args[0];
if (!verb) {
  console.error("usage: deno run -A scripts/pkg.ts <verb>");
  Deno.exit(2);
}

type Config = {
  name?: string;
  workspace?: string[];
  tasks?: Record<string, string>;
};

async function readConfig(dir: string): Promise<Config | null> {
  try {
    return JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
  } catch {
    return null;
  }
}

const rootCfg = await readConfig(ROOT);
const members: string[] = rootCfg?.workspace ?? [];

let ran = 0;
let failed = 0;
for (const rel of members) {
  const dir = join(ROOT, rel);
  const cfg = await readConfig(dir);
  if (!cfg?.tasks?.[verb]) continue;
  const label = cfg.name ?? rel;
  console.log(`\n=== ${label} :: ${verb} ===`);
  const { code } = await new Deno.Command("deno", {
    args: ["task", verb],
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  ran++;
  if (code !== 0) {
    failed++;
    console.error(`!! ${label} :: ${verb} failed (exit ${code})`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${ran} package(s) failed \`${verb}\`.`);
  Deno.exit(1);
}
console.log(`\n${verb}: ${ran} package(s) passed.`);
