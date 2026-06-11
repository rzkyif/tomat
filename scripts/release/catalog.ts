#!/usr/bin/env -S deno run -A
// release:catalog: compiles the hand-authored @tomat/model-catalog families into
// one catalog.json, signs it (whole-payload-minus-signature, like core.json /
// toolkit.json), and uploads it to R2.
//
// Flags:
//   --channel=stable|beta   (required via the channel-specific deno tasks)
//   --dry-run               build + sign locally; skip R2 upload
//   --help

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path";
import { encodeBase64 } from "@std/encoding/base64";
import type { ModelCatalog } from "../../packages/tomat-shared/src/domain/catalog.ts";
import { buildCatalogPayload } from "../../packages/tomat-model-catalog/src/index.ts";
import {
  channelManifestDir,
  colors,
  DIST_DIR,
  fail,
  info,
  loadOrSeedEnv,
  ok,
  parseChannelFlag,
  r2Put,
  rel,
  type ReleaseChannel,
  signEd25519,
  step,
  writeSigningKeys,
} from "./lib.ts";

const MANIFEST_CACHE_CONTROL = "public, max-age=300";

interface Flags {
  channel: ReleaseChannel;
  dryRun: boolean;
}

function parseFlags(): Flags {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel"],
      boolean: ["dry-run", "help"],
      default: { "dry-run": false, help: false },
    },
  );
  if (args.help) {
    console.log(`Usage: deno task release:catalog:<channel> [flags]

Flags:
  --channel=<c>   stable | beta
  --dry-run       build + sign locally; skip R2 upload
  --help`);
    Deno.exit(0);
  }
  return { channel: parseChannelFlag(args.channel), dryRun: args["dry-run"] };
}

export async function main(): Promise<void> {
  const flags = parseFlags();
  const manifestDir = channelManifestDir(flags.channel);

  step(`Releasing model catalog for the "${flags.channel}" channel`);
  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  step("Updating packages/tomat-core/data/signing-keys.json");
  await writeSigningKeys(encodeBase64(env.signingPublicKey));

  step("Compiling + validating catalog");
  const payload = buildCatalogPayload(new Date().toISOString());
  const modelCount = payload.families.reduce((n, f) => n + f.models.length, 0);
  ok(
    `${payload.families.length} families, ${modelCount} models, ` +
      `${payload.stt.models.length} stt models`,
  );

  step("Signing catalog.json");
  const catalog: ModelCatalog = {
    ...payload,
    signature: await signEd25519(env.signingPrivateKey, payload),
  };
  const manifestPath = join(DIST_DIR, manifestDir, "catalog.json");
  await ensureDir(join(DIST_DIR, manifestDir));
  await Deno.writeTextFile(manifestPath, JSON.stringify(catalog, null, 2));
  ok(`signed catalog.json → ${rel(manifestPath)}`);

  if (flags.dryRun) {
    step("Dry-run: skipping R2 upload");
    console.log(
      colors.yellow(`\nArtifact at ${rel(manifestPath)}. Re-run without --dry-run to publish.`),
    );
    return;
  }

  step(`Uploading to R2 bucket "${env.r2Bucket}"`);
  info(`uploading ${manifestDir}/catalog.json`);
  await r2Put(
    env,
    `${manifestDir}/catalog.json`,
    manifestPath,
    "application/json",
    MANIFEST_CACHE_CONTROL,
  );
  ok(`uploaded ${manifestDir}/catalog.json`);

  console.log(
    "\n" +
      colors.green(colors.bold(`✓ release:catalog complete (${flags.channel})`)) +
      "\n" +
      colors.dim("  ") +
      `https://${env.storageDomain}/${manifestDir}/catalog.json\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
