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

async function main(): Promise<void> {
  const flags = parseFlags();
  console.log(colors.bold(`\ntomat release: ${flags.channel} channel\n`));

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
    triples: flags.triples,
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
