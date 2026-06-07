#!/usr/bin/env -S deno run -A
// release:website: builds the Astro site and deploys the Worker.
//
// Idempotent: hashes the website source tree and compares against a cursor
// served from the Worker itself (https://${websiteDomain}/release-state.json).
// When the source is unchanged, skips both astro build and wrangler deploy.
// The cursor is generated into packages/tomat-website/public/release-state.json
// at deploy time, picked up by `astro build`, and published with the rest
// of the Astro output.
//
// Flags:
//   --dry-run   probe + build only; skip wrangler deploy
//   --force     skip the source-hash idempotency probe
//   --help

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, join } from "@std/path";
import {
  astroBuild,
  colors,
  fail,
  fetchHttpsJson,
  hashWebsiteSource,
  info,
  loadOrSeedEnv,
  ok,
  step,
  WEBSITE_DIR,
  WEBSITE_STATE_REL,
  wranglerDeploy,
} from "./lib.ts";

const STATE_FILE = join(WEBSITE_DIR, WEBSITE_STATE_REL);

interface Flags {
  dryRun: boolean;
  force: boolean;
}

function parseFlags(): Flags {
  // Strip the bare `--` token that `deno task <name> -- ...` passes through.
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      boolean: ["dry-run", "force", "help"],
      default: { "dry-run": false, force: false, help: false },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task release:website [flags]

Flags:
  --dry-run   build Astro locally; skip wrangler deploy
  --force     skip the source-hash idempotency probe
  --help`);
    Deno.exit(0);
  }
  return { dryRun: args["dry-run"], force: args.force };
}

export async function main(): Promise<void> {
  const flags = parseFlags();

  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  const localHash = await hashWebsiteSource();
  info(`source hash: ${localHash.slice(0, 12)}…`);

  if (!flags.force) {
    const stored = await fetchHttpsJson<{ hash?: string }>(
      `https://${env.websiteDomain}/release-state.json`,
    );
    if (stored?.hash === localHash) {
      ok(`landing-page source unchanged; nothing to do`);
      return;
    }
    if (stored?.hash) {
      info(`live hash: ${stored.hash.slice(0, 12)}…  → deploying`);
    } else {
      info(`no live cursor yet; first website release`);
    }
  }

  step("Writing public/release-state.json cursor");
  await ensureDir(dirname(STATE_FILE));
  await Deno.writeTextFile(
    STATE_FILE,
    JSON.stringify({ hash: localHash, timestamp: new Date().toISOString() }, null, 2) + "\n",
  );
  ok(`cursor → ${WEBSITE_STATE_REL}`);

  step("Building Astro site");
  await astroBuild();

  if (flags.dryRun) {
    info(colors.yellow("dry-run: skipping wrangler deploy"));
    return;
  }

  step("Deploying Worker via wrangler");
  await wranglerDeploy();

  console.log(
    "\n" +
      colors.green(colors.bold("✓ release:website complete")) +
      "\n" +
      colors.dim("  ") +
      `https://${env.websiteDomain}/\n` +
      colors.dim("  ") +
      `https://${env.websiteDomain}/release-state.json\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
