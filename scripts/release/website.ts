// Release item: the Astro landing page + its Cloudflare Worker. Channel-
// independent (one site serves every channel). sourceHash() hashes the website
// source tree; apply() builds Astro and deploys via wrangler. Idempotency is
// handled upstream by the release-state cursor, so there is no longer a
// self-served release-state.json.
//
// The landing page ships on its own track, separate from the umbrella release:
// `deno task release:website` runs the standalone entry at the bottom of this
// file, which plans + applies only this item via the same cursor + version-bump
// gate the umbrella release uses. wrangler authenticates with the CLOUDFLARE_*
// credentials from .env (see wranglerEnv in lib.ts).

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";
import {
  type ApplyOpts,
  astroBuild,
  colors,
  type DeployEnv,
  fail,
  hashWebsiteSource,
  info,
  loadOrSeedEnv,
  ok,
  parseChannelFlag,
  readVersionField,
  type ReleaseChannel,
  type ReleaseItem,
  runReleasePlan,
  step,
  WEBSITE_DIR,
  wranglerDeploy,
} from "./lib.ts";

export const websiteItem: ReleaseItem = {
  id: "website",
  label: "landing page",
  scope: "shared",
  packages: ["website", "shared"],
  bumpHint: "packages/tomat-website/deno.json (version)",

  version: () => readVersionField(join(WEBSITE_DIR, "deno.json")),

  sourceHash(_channel: ReleaseChannel): Promise<string> {
    return hashWebsiteSource();
  },

  // The Astro output dir that `deno task build:website` produces. The unified
  // build hash-checks it so a wiped/swapped site rebuilds.
  buildOutputs(_channel: ReleaseChannel): Promise<string[]> {
    return Promise.resolve([join(WEBSITE_DIR, "dist")]);
  },

  async apply(env: DeployEnv, _channel: ReleaseChannel, opts: ApplyOpts): Promise<void> {
    step("Building Astro site");
    await astroBuild();

    if (opts.dryRun) {
      info(colors.yellow("dry-run: skipping wrangler deploy"));
      return;
    }

    step("Deploying Worker via wrangler");
    await wranglerDeploy(env);
    ok(`https://${env.websiteDomain}/`);
  },
};

// ---------------------------------------------------------------------------
// standalone entry: `deno task release:website`
//
// Builds + deploys ONLY the landing page, on its own track from the umbrella
// `deno task release`. The website is scope:"shared" (one site for every
// channel), so the channel flag only picks the label; the cursor entry it reads
// and writes is the same regardless. Authenticates wrangler with .env's
// CLOUDFLARE_API_TOKEN like the rest of the release.

async function main(): Promise<void> {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel"],
      boolean: ["yes", "force", "dry-run", "help"],
      alias: { y: "yes" },
      default: { yes: false, force: false, "dry-run": false, help: false },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task release:website [flags]

Flags:
  --yes, -y                  skip the confirmation prompt
  --force                    ignore the cursor; deploy even if unchanged
  --dry-run                  build Astro locally; skip wrangler deploy + cursor
  --help`);
    Deno.exit(0);
  }

  const channel = parseChannelFlag(args.channel);
  console.log(colors.bold(`\ntomat website release\n`));

  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  const published = await runReleasePlan(env, [websiteItem], channel, {
    yes: args.yes,
    force: args.force,
    dryRun: args["dry-run"],
    triples: [Deno.build.target as Triple],
  });

  if (published > 0 && !args["dry-run"]) {
    console.log("\n" + colors.green(colors.bold(`✓ website published`)) + "\n");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
