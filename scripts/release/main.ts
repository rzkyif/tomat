#!/usr/bin/env -S deno run -A
// release: runs all five release sub-tasks in sequence inside one process.
//
// Each sub-script is idempotent: cheap probes against R2/Worker decide whether
// there's work to do. With no source changes since the last release, this
// completes in seconds with five "up to date" lines.
//
// All flags supported by sub-tasks (--channel, --triples, --skip-build,
// --dry-run, --force) are read from Deno.args by each sub-script directly.

import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { colors, fail, ok, parseChannelFlag, step } from "./lib.ts";
import { main as runCore } from "./core.ts";
import { main as runClient } from "./client.ts";
import { main as runScripts } from "./install-scripts.ts";
import { main as runSchemas } from "./schemas.ts";
import { main as runWebsite } from "./website.ts";

async function main(): Promise<void> {
  // The channel flag is consumed by core.ts / client.ts directly off Deno.args;
  // we parse it here only to label the run. install-scripts / schemas /
  // website are channel-independent (one shared copy serves every channel).
  const { channel } = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel"],
    },
  );
  const ch = parseChannelFlag(channel);
  console.log(colors.bold(`\ntomat release: ${ch} channel\n`));
  step("RELEASE 1/5: core");
  await runCore();
  step("RELEASE 2/5: client");
  await runClient();
  step("RELEASE 3/5: install scripts");
  await runScripts();
  step("RELEASE 4/5: schemas");
  await runSchemas();
  step("RELEASE 5/5: website");
  await runWebsite();
  ok(`release complete (${ch})`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
