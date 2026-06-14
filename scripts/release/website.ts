// Release item: the Astro landing page + its Cloudflare Worker. Channel-
// independent (one site serves every channel). sourceHash() hashes the website
// source tree; apply() builds Astro and deploys via wrangler. Idempotency is
// handled upstream by the release-state cursor, so there is no longer a
// self-served release-state.json.

import { join } from "@std/path";
import {
  type ApplyOpts,
  astroBuild,
  colors,
  type DeployEnv,
  hashWebsiteSource,
  info,
  ok,
  readVersionField,
  type ReleaseChannel,
  type ReleaseItem,
  step,
  WEBSITE_DIR,
  wranglerDeploy,
} from "./lib.ts";

export const websiteItem: ReleaseItem = {
  id: "website",
  label: "landing page",
  scope: "shared",
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
    await wranglerDeploy();
    ok(`https://${env.websiteDomain}/`);
  },
};
