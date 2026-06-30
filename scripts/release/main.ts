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
//   --triples=all|host|<csv>  targets to release (default all); host = release:native
//   --yes / -y                skip the confirmation prompt (CI)
//   --force                   ignore the cursor; treat every item as changed
//   --dry-run                 build locally, skip every R2 upload + cursor write
//   --help

import { parseArgs } from "@std/cli/parse-args";
import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";
import {
  colors,
  fail,
  info,
  loadOrSeedEnv,
  PACKAGES,
  parseChannelFlag,
  type ReleaseChannel,
  type ReleaseItem,
  runReleasePlan,
  step,
  writeSigningKeys,
} from "./lib.ts";
import { encodeBase64 } from "@std/encoding/base64";
import { ALL_KNOWN_TRIPLES, RELEASE_TARGET_TRIPLES } from "./all-targets.ts";
import type { BuildEnvironment } from "./drivers/mod.ts";
import { podmanLinuxDriver } from "./drivers/podman.ts";
import { windowsUtmDriver } from "./drivers/windows.ts";
import { coreItem } from "./core.ts";
import { extensionItem } from "./extension.ts";
import { catalogItem } from "./catalog.ts";
import { clientItem } from "./client.ts";
import { androidItem } from "./android.ts";
import { scriptsItem } from "./install-scripts.ts";
import { schemasItem } from "./schemas.ts";

// Apply order: core first (everything else can depend on it being published).
// The landing page ships on its own track via `deno task release:website`
// (scripts/release/website.ts), so it is not part of this umbrella run.
const ITEMS: ReleaseItem[] = [
  coreItem,
  extensionItem,
  catalogItem,
  clientItem,
  androidItem,
  scriptsItem,
  schemasItem,
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
  /** Triples the user asked to release for (already validated). */
  requestedTriples: Triple[];
  /** True when releasing for more than just the host triple (the `release`
   *  task; `release:native` stays host-only). Drives the multi-env build path. */
  crossPlatform: boolean;
  yes: boolean;
  force: boolean;
  dryRun: boolean;
  githubRelease: boolean;
}

function parseFlags(): Flags {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel", "triples"],
      boolean: ["yes", "force", "dry-run", "help", "github-release"],
      alias: { y: "yes" },
      default: {
        yes: false,
        force: false,
        "dry-run": false,
        help: false,
        "github-release": false,
      },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task release[:native][:stable] [flags]

Flags:
  --triples=all|host|<csv>   all targets (default), host only, or a triple list
  --yes, -y                  skip the confirmation prompt
  --force                    ignore the cursor; treat every item as changed
  --dry-run                  build locally; skip R2 uploads + cursor write
  --github-release           also mirror to the rolling per-channel GitHub Release
  --help`);
    Deno.exit(0);
  }
  // `host` (release:native) builds only this machine's triple. `all` (the
  // default `release` task) and an explicit csv build across targets: the host
  // builds what it can natively and on-demand environments build the rest.
  const spec = (args.triples ?? "all").trim();
  let requestedTriples: Triple[];
  if (spec === "host") {
    requestedTriples = [Deno.build.target as Triple];
  } else if (spec === "all") {
    requestedTriples = RELEASE_TARGET_TRIPLES;
  } else {
    requestedTriples = spec.split(",").map((t) => t.trim()) as Triple[];
    for (const t of requestedTriples) {
      if (!ALL_KNOWN_TRIPLES.includes(t)) {
        fail(`unknown --triples entry "${t}". Valid: ${ALL_KNOWN_TRIPLES.join(", ")}, host, all`);
      }
    }
  }
  const crossPlatform = !(
    requestedTriples.length === 1 && requestedTriples[0] === (Deno.build.target as Triple)
  );
  return {
    channel: parseChannelFlag(args.channel),
    requestedTriples,
    crossPlatform,
    yes: args.yes,
    force: args.force,
    dryRun: args["dry-run"],
    githubRelease: args["github-release"],
  };
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const mode = flags.crossPlatform ? "all targets" : "host only";
  console.log(colors.bold(`\ntomat release: ${flags.channel} channel (${mode})\n`));

  // Cross-platform runs pass on-demand build environments; the core item routes
  // each triple to the host (its own OS) or a driver (started for the build, then
  // stopped), and reports what it couldn't build. The host-only path
  // (release:native) passes no environments and builds just the host triple.
  const environments: BuildEnvironment[] | undefined = flags.crossPlatform
    ? [podmanLinuxDriver, windowsUtmDriver]
    : undefined;

  step("Loading deploy environment");
  const env = await loadOrSeedEnv();
  await writeSigningKeys(encodeBase64(env.signingPublicKey));

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

  const published = await runReleasePlan(env, items, flags.channel, {
    yes: flags.yes,
    force: flags.force,
    dryRun: flags.dryRun,
    triples: flags.requestedTriples,
    environments,
    githubRelease: flags.githubRelease,
  });

  if (published > 0 && !flags.dryRun) {
    console.log(
      "\n" +
        colors.green(colors.bold(`✓ release complete (${flags.channel})`)) +
        `  ${published} item(s) published\n`,
    );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
