#!/usr/bin/env -S deno run -A
// CI post-publish version bump: the committed counterpart to the local release's
// auto-bump. It runs as the final job of the Release workflow, AFTER ci-publish
// has published the latest channel, and does what a local `deno task release`
// does after publishing: bump the just-published items' version files, commit
// them to `main`, record the post-bump source hash in the shared R2 cursor, and
// fast-forward `latest` onto the bump commit.
//
// Latest channel only: a stable release is a fast-forward promotion of
// already-bumped versions, so there is nothing to bump (the workflow only runs
// this job on the latest branch; this script also no-ops on any other channel).
//
// Which items to bump: after ci-publish's noBump write, a just-published item's
// recorded cursor version equals its local version (the version file has not
// been advanced yet). Every other item was bumped after its last release, so its
// local version is strictly greater. So "recorded.version === local version"
// selects exactly the items this release published and left un-bumped.
//
// Idempotency: the bump commit's post-bump hash is written to the cursor BEFORE
// `latest` moves onto it, so the resulting latest push is a preflight no-op
// (nothing changed, this bump job skipped). If `main` advanced since the built
// commit (a concurrent push), the bump is skipped and left to the next release.
//
// Flags:
//   --channel=stable|latest    target channel (the workflow sets it from branch)
//   --dry-run                  bump + commit locally; no cursor write or push

import { parseArgs } from "@std/cli/parse-args";
import {
  bumpPatch,
  colors,
  fail,
  info,
  loadOrSeedEnv,
  ok,
  parseChannelFlag,
  type PublishedItem,
  readReleaseCursor,
  type ReleaseChannel,
  type ReleaseItem,
  step,
  writeReleaseCursor,
} from "./lib.ts";
import { commitVersionBump, pushChannelBranch, pushMain, revParse } from "./git-align.ts";
import { coreItem } from "./core.ts";
import { extensionItem } from "./extension.ts";
import { catalogItem } from "./catalog.ts";
import { clientItem } from "./client.ts";
import { androidItem } from "./android.ts";
import { scriptsItem } from "./install-scripts.ts";
import { schemasItem } from "./schemas.ts";

// The same set ci-preflight / ci-publish plan against (iOS ships through the App
// Store, not the R2 cursor, so it is not here).
const ITEMS: ReleaseItem[] = [
  coreItem,
  extensionItem,
  catalogItem,
  clientItem,
  androidItem,
  scriptsItem,
  schemasItem,
];

function recordedFor(
  cursor: Awaited<ReturnType<typeof readReleaseCursor>>,
  item: ReleaseItem,
  channel: ReleaseChannel,
) {
  return item.scope === "shared" ? cursor.shared[item.id] : cursor.channels[channel]?.[item.id];
}

async function main(): Promise<void> {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    { string: ["channel"], boolean: ["dry-run"], default: { "dry-run": false } },
  );
  const channel = parseChannelFlag(args.channel);
  const dryRun = args["dry-run"];
  console.log(colors.bold(`\ntomat ci-bump: ${channel} channel\n`));

  if (channel !== "latest") {
    ok(`nothing to bump on the ${channel} channel (promotions carry bumped versions)`);
    return;
  }

  // Only bump on top of the exact commit that was built + published. If `main`
  // moved since (a concurrent push), fast-forwarding `latest` onto a bump built
  // from the newer tree would skip those commits past CI; leave it to the next
  // release instead.
  const built = Deno.env.get("GITHUB_SHA");
  if (built) {
    const head = await revParse("HEAD");
    if (head !== built) {
      info(
        colors.yellow(
          `main (${head.slice(0, 12)}) has advanced past the built commit ` +
            `(${built.slice(0, 12)}); skipping the auto-bump. The next release will bump.`,
        ),
      );
      return;
    }
  }

  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  step("Reading release-state cursor");
  const cursor = await readReleaseCursor(env);

  // Select the just-published, un-bumped items (recorded version === local).
  const selected: Array<{ item: ReleaseItem; recordedVersion: string }> = [];
  for (const item of ITEMS) {
    const recorded = recordedFor(cursor, item, channel);
    if (!recorded?.version) continue;
    const local = await item.version();
    if (local === recorded.version) selected.push({ item, recordedVersion: recorded.version });
  }

  if (selected.length === 0) {
    ok(`no just-published items to bump; ${channel} is already bumped`);
    return;
  }

  // Preview only: report what would bump without touching the tree, cursor, or
  // branches (bumpPatch mirrors bumpVersion's patch increment).
  if (dryRun) {
    step("dry-run: version bump preview (no writes)");
    const seen = new Set<string>();
    for (const { item, recordedVersion } of selected) {
      if (seen.has(item.versionFile)) continue;
      seen.add(item.versionFile);
      info(`would bump ${item.label} ${recordedVersion} -> ${bumpPatch(recordedVersion)}`);
    }
    info(colors.yellow("dry-run: skipping bump, commit, cursor write, and branch pushes"));
    return;
  }

  // Bump each selected item's version file (dedupe by file so a shared file like
  // tauri.conf.json bumps once), then commit as `bump: <labels>`.
  step("Bumping versions for the next release");
  const bumpedFiles = new Set<string>();
  const bumped: PublishedItem[] = [];
  for (const { item, recordedVersion } of selected) {
    if (!bumpedFiles.has(item.versionFile)) {
      bumpedFiles.add(item.versionFile);
      const next = await item.bumpVersion();
      ok(`bumped ${item.label} ${recordedVersion} -> ${next}`);
    }
    bumped.push({
      id: item.id,
      label: item.label,
      versionFile: item.versionFile,
      sourceChanged: true,
      version: recordedVersion,
    });
  }

  await commitVersionBump(bumped);

  // Record the post-bump source hash so the latest push below is a preflight
  // no-op. The recorded version stays at what was published (the gate's
  // local > recorded check passes next cycle).
  step("Recording post-bump source hash in the cursor");
  for (const { item } of selected) {
    const state = recordedFor(cursor, item, channel);
    if (state) state.sourceHash = await item.sourceHash(channel);
  }

  await writeReleaseCursor(env, cursor);
  ok(`cursor updated (${selected.length} item(s))`);

  // Persist the bump on main, then fast-forward latest onto it. Cursor is written
  // first, so the latest push (which re-triggers the workflow) sees no changes.
  await pushMain();
  await pushChannelBranch(channel);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
