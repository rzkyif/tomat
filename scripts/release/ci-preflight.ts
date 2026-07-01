#!/usr/bin/env -S deno run -A
// CI preflight: decide whether a channel-branch push has anything to publish.
//
// The Release workflow runs on every push to `latest` / `stable`, but a local
// `deno task release` also pushes those branches after it has already published
// to R2. To keep that local-release push from re-running the whole build matrix,
// this job diffs each release item against the shared R2 release-state cursor
// (the same change detection runReleasePlan uses) and emits `changed=true|false`
// to $GITHUB_OUTPUT. The build + publish jobs gate on it.
//
// Reads only the public R2 cursor + live manifests, so it needs no deploy
// credentials; envFromProcess just wants the (non-secret) Ed25519 PUBLIC key.
//
// Flags:
//   --channel=stable|latest   target channel (the workflow sets it from the branch)

import { parseArgs } from "@std/cli/parse-args";
import {
  colors,
  envFromProcess,
  fail,
  hasReleaseChanges,
  ok,
  parseChannelFlag,
  type ReleaseItem,
  step,
} from "./lib.ts";
import { coreItem } from "./core.ts";
import { extensionItem } from "./extension.ts";
import { catalogItem } from "./catalog.ts";
import { clientItem } from "./client.ts";
import { androidItem } from "./android.ts";
import { scriptsItem } from "./install-scripts.ts";
import { schemasItem } from "./schemas.ts";

// The same set the umbrella release (main.ts) and ci-publish plan against.
const ITEMS: ReleaseItem[] = [
  coreItem,
  extensionItem,
  catalogItem,
  clientItem,
  androidItem,
  scriptsItem,
  schemasItem,
];

async function main(): Promise<void> {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    { string: ["channel"] },
  );
  const channel = parseChannelFlag(args.channel);
  console.log(colors.bold(`\ntomat ci-preflight: ${channel} channel\n`));

  step("Diffing release items against the R2 cursor");
  const env = envFromProcess();
  const changed = await hasReleaseChanges(env, ITEMS, channel);
  ok(
    changed
      ? "changes detected; build + publish will run"
      : "nothing changed; build + publish will be skipped",
  );

  const outFile = Deno.env.get("GITHUB_OUTPUT");
  if (outFile) await Deno.writeTextFile(outFile, `changed=${changed}\n`, { append: true });
  else console.log(`changed=${changed}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
