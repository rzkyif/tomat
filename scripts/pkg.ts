// Fans a standardized verb (check, lint, fmt, fmt:check, test, test:js, build,
// ...) out across the workspace members that define it, reading the package list
// from the root `deno.json` `workspace` array (the single source of truth for
// packages).
//
// Each member is run in isolation via its own `deno task`, so the root's
// same-named aggregate is never re-entered (a `deno task -r <verb>` / glob
// `--filter` would also run the root task and recurse). Per-package tasks live
// in each package's `deno.json`; this script is only the fan-out.
//
// Packages run concurrently (bounded pool); each package's output is buffered
// and flushed as one labeled block so concurrent runs stay readable. Cap the
// pool with TOMAT_PKG_CONCURRENCY (defaults to the host's logical core count).
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

// Resolve the members that actually define the verb, preserving workspace order
// so the failure summary is stable.
const targets: { dir: string; label: string }[] = [];
for (const rel of members) {
  const dir = join(ROOT, rel);
  const cfg = await readConfig(dir);
  if (!cfg?.tasks?.[verb]) continue;
  targets.push({ dir, label: cfg.name ?? rel });
}

const concurrency = Math.max(
  1,
  Number(Deno.env.get("TOMAT_PKG_CONCURRENCY")) || navigator.hardwareConcurrency || 4,
);

let failed = 0;
let next = 0;
async function worker() {
  while (next < targets.length) {
    const target = targets[next++];
    const { code, stdout, stderr } = await new Deno.Command("deno", {
      args: ["task", verb],
      cwd: target.dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    const out = (decoder.decode(stdout) + decoder.decode(stderr)).trimEnd();
    const lines = [`\n=== ${target.label} :: ${verb} ===`];
    if (out) lines.push(out);
    if (code !== 0) {
      failed++;
      lines.push(`!! ${target.label} :: ${verb} failed (exit ${code})`);
    }
    // console.log is synchronous, so buffered blocks never interleave.
    console.log(lines.join("\n"));
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));

if (failed > 0) {
  console.error(`\n${failed} of ${targets.length} package(s) failed \`${verb}\`.`);
  Deno.exit(1);
}
console.log(`\n${verb}: ${targets.length} package(s) passed.`);
