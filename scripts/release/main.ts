#!/usr/bin/env -S deno run -A
// Unified release: one entry point (`deno task release` -> latest channel,
// `deno task release:stable` -> stable) that rounds up every release item,
// diffs each against what's published (via the release-state cursor on R2),
// rejects the run if a changed *versioned* item wasn't bumped, shows a plan of
// what will change, asks for a single y/N confirmation, and only then builds +
// uploads the changed items.
//
// Flags:
//   --channel=stable|latest   target channel (the deno tasks set this)
//   --triples=host|all|csv    triples to build for core/client (default host)
//   --yes / -y                skip the confirmation prompt (CI)
//   --force                   ignore the cursor; treat every item as changed
//   --dry-run                 build locally, skip every R2 upload + cursor write
//   --help

import { parseArgs } from "@std/cli/parse-args";
import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";
import {
  type ApplyOpts,
  colors,
  type DeployEnv,
  fail,
  info,
  loadOrSeedEnv,
  ok,
  PACKAGES,
  parseChannelFlag,
  promptYesNo,
  readReleaseCursor,
  type ReleaseChannel,
  type ReleaseCursor,
  type ReleaseItem,
  semverGt,
  step,
  writeReleaseCursor,
  writeSigningKeys,
} from "./lib.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { coreItem } from "./core.ts";
import { extensionItem } from "./extension.ts";
import { catalogItem } from "./catalog.ts";
import { clientItem } from "./client.ts";
import { androidItem } from "./android.ts";
import { scriptsItem } from "./install-scripts.ts";
import { schemasItem } from "./schemas.ts";
import { websiteItem } from "./website.ts";

// Apply order: core first (everything else can depend on it being published),
// website last.
const ITEMS: ReleaseItem[] = [
  coreItem,
  extensionItem,
  catalogItem,
  clientItem,
  androidItem,
  scriptsItem,
  schemasItem,
  websiteItem,
];

// Drift guard: every package a release item claims to be built from must exist
// in the package table. Catches a release item referencing a renamed or removed
// package (the derived-hash items also throw, this covers the documented ones).
for (const item of ITEMS) {
  for (const id of item.packages) {
    if (!(id in PACKAGES)) {
      throw new Error(`release item "${item.id}" references unknown package "${id}"`);
    }
  }
}

interface Flags {
  channel: ReleaseChannel;
  triples: Triple[];
  yes: boolean;
  force: boolean;
  dryRun: boolean;
}

function parseFlags(): Flags {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel", "triples"],
      boolean: ["yes", "force", "dry-run", "help"],
      alias: { y: "yes" },
      default: { yes: false, force: false, "dry-run": false, help: false },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task release[:stable] [flags]

Flags:
  --triples=host             host triple only; cross-compilation is unsupported
  --yes, -y                  skip the confirmation prompt
  --force                    ignore the cursor; treat every item as changed
  --dry-run                  build locally; skip R2 uploads + cursor write
  --help`);
    Deno.exit(0);
  }
  // The release builds ONLY the host triple. Cross-compilation is not supported
  // (notably tomat-core-speech statically links a native ONNX runtime that cannot
  // be cross-compiled from a single host); the dedicated per-OS release CI builds
  // each platform on its own native runner via scripts/build-core.ts.
  const triples: Triple[] = [Deno.build.target as Triple];
  if (args.triples && args.triples !== "host") {
    fail(
      `--triples="${args.triples}" is not supported: the release builds the host ` +
        `triple only (${Deno.build.target}). Use the per-OS release CI for all platforms.`,
    );
  }
  return {
    channel: parseChannelFlag(args.channel),
    triples,
    yes: args.yes,
    force: args.force,
    dryRun: args["dry-run"],
  };
}

interface PlanEntry {
  item: ReleaseItem;
  changed: boolean;
  /** the source hash itself changed (gates a version bump). */
  sourceChanged: boolean;
  localVersion: string;
  recordedVersion?: string;
  localHash: string;
  /** human description shown in the plan table. */
  desc: string;
}

function cursorState(
  cursor: ReleaseCursor,
  item: ReleaseItem,
  channel: ReleaseChannel,
): { version?: string; sourceHash: string } | undefined {
  return item.scope === "shared" ? cursor.shared[item.id] : cursor.channels[channel]?.[item.id];
}

async function planItem(
  env: DeployEnv,
  item: ReleaseItem,
  channel: ReleaseChannel,
  cursor: ReleaseCursor,
  force: boolean,
): Promise<PlanEntry> {
  const localHash = await item.sourceHash(channel);
  const localVersion = await item.version();
  const recorded = cursorState(cursor, item, channel);
  const sourceChanged = force || !recorded || recorded.sourceHash !== localHash;
  const extra = item.extraChanged ? await item.extraChanged(env, channel) : false;
  const changed = sourceChanged || extra;

  let desc: string;
  if (!changed) {
    desc = "up to date";
  } else if (sourceChanged) {
    desc = `v${recorded?.version ?? "none"} → v${localVersion}`;
  } else {
    // changed only because a platform is missing at the current version
    desc = `v${localVersion} (publish missing platform)`;
  }

  return {
    item,
    changed,
    sourceChanged,
    localVersion,
    recordedVersion: recorded?.version,
    localHash,
    desc,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags();
  console.log(colors.bold(`\ntomat release: ${flags.channel} channel\n`));

  step("Loading deploy environment");
  const env = await loadOrSeedEnv();
  await writeSigningKeys(encodeBase64(env.signingPublicKey));

  step("Reading release-state cursor");
  const cursor = await readReleaseCursor(env);

  // The client can only be released when the Tauri updater keys are present,
  // and the android APK only when its signing keystore is present; drop either
  // from the run (with a warning) rather than marking it released.
  const items = ITEMS.filter((it) => {
    if (it.id === "client" && (!env.tauriUpdaterPublicKey || !env.tauriUpdaterPrivateKey)) {
      info(colors.yellow(`Tauri updater keys not set in .env; skipping the client this run.`));
      return false;
    }
    if (it.id === "android" && !env.androidKeystoreB64) {
      info(colors.yellow(`Android keystore not set in .env; skipping the android APK this run.`));
      return false;
    }
    return true;
  });

  step("Planning");
  const plans: PlanEntry[] = [];
  for (const item of items) {
    plans.push(await planItem(env, item, flags.channel, cursor, flags.force));
  }

  // Version-bump gate: any item whose source changed but whose version isn't
  // strictly greater than what's published is rejected (only when a prior
  // record exists; the first release of an item is always allowed). A
  // platform-fill change (sourceChanged === false) never requires a bump.
  const needsBump = plans.filter(
    (p) =>
      p.sourceChanged &&
      p.recordedVersion !== undefined &&
      !semverGt(p.localVersion, p.recordedVersion),
  );
  if (needsBump.length > 0) {
    console.log("\n" + colors.red(colors.bold("Release rejected: version bump required")) + "\n");
    for (const p of needsBump) {
      console.log(
        "  " +
          colors.red("✗") +
          ` ${p.item.label}: changed but still v${p.localVersion} ` +
          `(published v${p.recordedVersion}). Bump ${p.item.bumpHint}`,
      );
    }
    fail(`bump the version(s) above, then re-run.`);
  }

  const changed = plans.filter((p) => p.changed);
  if (changed.length === 0) {
    ok(`nothing to release; everything matches the ${flags.channel} channel`);
    return;
  }

  console.log("\n" + colors.bold(`Release plan (${flags.channel}):`) + "\n");
  for (const p of changed) {
    console.log("  " + colors.green("•") + ` ${p.item.label.padEnd(18)} ${p.desc}`);
  }
  console.log("");

  // Confirm before doing any work. Change detection already told us what
  // differs; the build happens as part of each item's apply() after the user
  // says yes.
  if (flags.dryRun) {
    info(colors.yellow("dry-run: building locally, no uploads or cursor write"));
  } else if (!flags.yes && !promptYesNo("Proceed with release?")) {
    info("aborted; nothing was released.");
    return;
  }

  const opts: ApplyOpts = { triples: flags.triples, dryRun: flags.dryRun };
  for (const p of changed) {
    step(`Releasing: ${p.item.label}`);
    await p.item.apply(env, flags.channel, opts);
  }

  if (flags.dryRun) {
    ok(`dry-run complete; ${changed.length} item(s) built locally, nothing published`);
    return;
  }

  step("Updating release-state cursor");
  for (const p of changed) {
    const state = { version: p.localVersion, sourceHash: p.localHash };
    if (p.item.scope === "shared") {
      cursor.shared[p.item.id] = state;
    } else {
      (cursor.channels[flags.channel] ??= {})[p.item.id] = state;
    }
  }
  await writeReleaseCursor(env, cursor);
  ok(`cursor updated`);

  console.log(
    "\n" +
      colors.green(colors.bold(`✓ release complete (${flags.channel})`)) +
      `  ${changed.length} item(s) published\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
