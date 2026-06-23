#!/usr/bin/env -S deno run -A
// Unified build: compiles every local artifact whose source changed since the
// last build, and skips the rest.
//
// Idempotency comes from a dist/.build-state.json cursor recording each item's
// {source, output} hashes. The source hash reuses the very same sourceHash()
// the release system uses to detect changes (so "needs building" and "needs
// releasing" can't drift apart). The output hash is taken over the item's
// compiled artifacts (the paths its buildOutputs() reports). An item rebuilds
// when either differs from the cursor, so a wiped dist/ or a swapped artifact
// forces a rebuild instead of a false "up to date". `deno task clean` removes
// dist/, which clears the cursor and forces a full rebuild; --force does the
// same without cleaning.
//
// Builds (core + helpers, client, catalog, website). The extension tarball and
// the install scripts / schemas have no compile step, so they're release-only.
//
// Flags:
//   --channel=stable|latest   channel for the core/client builds (default latest)
//   --force                   rebuild every item, ignoring the cursor
//   --help

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path";
import {
  colors,
  DIST_DIR,
  exists,
  fail,
  hashPaths,
  info,
  ok,
  parseChannelFlag,
  type ReleaseChannel,
  type ReleaseItem,
  REPO_ROOT,
  step,
} from "./release/lib.ts";
import { coreItem } from "./release/core.ts";
import { clientItem } from "./release/client.ts";
import { catalogItem } from "./release/catalog.ts";
import { websiteItem } from "./release/website.ts";

const BUILD_STATE = join(DIST_DIR, ".build-state.json");

interface Buildable {
  /** Cursor key. Channel-specific items (core/client) include the channel so a
   *  latest build and a stable build are tracked (and skipped) independently. */
  key: string;
  label: string;
  sourceHash(): Promise<string>;
  /** Content hash of the compiled artifacts on disk. Missing artifacts hash
   *  differently (hashPaths skips absent paths), so a wiped or swapped output
   *  no longer matches the cursor and triggers a rebuild. */
  outputHash(): Promise<string>;
  /** Args to `deno`, run from the repo root. */
  cmd: string[];
}

/** {source, output} hashes recorded after each item's last successful build. */
interface BuildRecord {
  source: string;
  output: string;
}
type BuildState = Record<string, BuildRecord>;

interface Flags {
  channel: ReleaseChannel;
  force: boolean;
}

function parseFlags(): Flags {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel"],
      boolean: ["force", "help"],
      default: { force: false, help: false },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task build[:stable] [flags]

Flags:
  --channel=stable|latest   channel for the core/client builds (default latest)
  --force                   rebuild every item, ignoring the cursor
  --help`);
    Deno.exit(0);
  }
  // Build's unlabeled default is the latest channel (matching build:core /
  // build:client), unlike the release lib's stable default.
  return {
    channel: parseChannelFlag(args.channel ?? "latest"),
    force: args.force,
  };
}

/** Hash an item's compiled artifacts via its buildOutputs() path list. */
function outputHash(item: ReleaseItem, channel: ReleaseChannel): Promise<string> {
  return item.buildOutputs!(channel).then((paths) => hashPaths(paths.map((path) => ({ path }))));
}

function buildables(channel: ReleaseChannel): Buildable[] {
  return [
    {
      key: `core:${channel}`,
      label: "core + helpers",
      sourceHash: () => coreItem.sourceHash(channel),
      outputHash: () => outputHash(coreItem, channel),
      cmd: ["run", "-A", "scripts/build-core.ts", `--channel=${channel}`],
    },
    {
      key: `client:${channel}`,
      label: "desktop client",
      sourceHash: () => clientItem.sourceHash(channel),
      outputHash: () => outputHash(clientItem, channel),
      cmd: ["run", "-A", "scripts/build-client.ts", `--channel=${channel}`],
    },
    {
      key: "catalog",
      label: "model catalog",
      sourceHash: () => catalogItem.sourceHash(channel),
      outputHash: () => outputHash(catalogItem, channel),
      cmd: ["run", "-A", "scripts/catalog/build.ts"],
    },
    {
      key: "website",
      label: "landing page",
      sourceHash: () => websiteItem.sourceHash(channel),
      outputHash: () => outputHash(websiteItem, channel),
      cmd: ["run", "-A", "scripts/website/build.ts"],
    },
  ];
}

async function readState(): Promise<BuildState> {
  if (!(await exists(BUILD_STATE))) return {};
  try {
    return JSON.parse(await Deno.readTextFile(BUILD_STATE)) as BuildState;
  } catch {
    return {};
  }
}

async function writeState(state: BuildState): Promise<void> {
  await ensureDir(DIST_DIR);
  await Deno.writeTextFile(BUILD_STATE, JSON.stringify(state, null, 2) + "\n");
}

/** Why an item must build, or "" if it's up to date (source and output both
 *  match the cursor). The output hash is only computed on the up-to-date
 *  candidate path, so the rebuild cases stay cheap. */
async function buildReason(
  item: Buildable,
  rec: BuildRecord | undefined,
  source: string,
  force: boolean,
): Promise<string> {
  if (force) return "forced";
  if (!rec) return "never built";
  if (rec.source !== source) return "source changed";
  if ((await item.outputHash()) !== rec.output) {
    return "outputs missing or changed";
  }
  return "";
}

async function runBuild(cmd: string[]): Promise<void> {
  const p = new Deno.Command("deno", {
    args: cmd,
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) fail(`build exited ${code}: deno ${cmd.join(" ")}`);
}

async function main(): Promise<void> {
  const flags = parseFlags();
  console.log(colors.bold(`\ntomat build: ${flags.channel} channel\n`));

  const state = await readState();
  const items = buildables(flags.channel);
  let built = 0;
  for (const item of items) {
    const source = await item.sourceHash();
    const reason = await buildReason(item, state[item.key], source, flags.force);
    if (!reason) {
      info(`up to date: ${item.label}`);
      continue;
    }
    step(`Building: ${item.label} (${reason})`);
    await runBuild(item.cmd);
    // Record source + output hashes only after a successful build, and persist
    // immediately so a later failure doesn't force the just-built items to
    // rebuild on the next run.
    state[item.key] = { source, output: await item.outputHash() };
    await writeState(state);
    built++;
  }

  if (built === 0) ok("everything up to date; nothing to build");
  else ok(`built ${built}/${items.length} item(s) (${flags.channel})`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
