#!/usr/bin/env -S deno run -A
// release:schemas: uploads the published JSON schemas (currently just
// tools-v1.json) to R2 under schemas/. Per-file idempotent.
//
// Flags:
//   --dry-run   probe + report only; no uploads
//   --force     upload every file regardless of equality
//   --help

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import {
  bytesEqual,
  colors,
  fail,
  fetchR2Bytes,
  info,
  loadOrSeedEnv,
  ok,
  r2Put,
  REPO_ROOT,
  step,
} from "./lib.ts";

const SCHEMAS: Array<{ src: string; r2Key: string }> = [
  {
    src: "packages/tomat-shared/src/tools-json-schema.json",
    r2Key: "schemas/tools-v1.json",
  },
];

const SCHEMA_CACHE_CONTROL = "public, max-age=3600";

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
    console.log(`Usage: deno task release:schemas [flags]

Flags:
  --dry-run   probe + report only; no uploads
  --force     upload every file regardless of equality
  --help`);
    Deno.exit(0);
  }
  return { dryRun: args["dry-run"], force: args.force };
}

export async function main(): Promise<void> {
  const flags = parseFlags();

  step("Loading deploy environment");
  const env = await loadOrSeedEnv();

  step(`Syncing ${SCHEMAS.length} JSON schemas to R2`);
  let uploaded = 0;
  for (const { src, r2Key } of SCHEMAS) {
    const fullSrc = join(REPO_ROOT, src);
    const local = await Deno.readFile(fullSrc);
    const remote = flags.force ? null : await fetchR2Bytes(env, r2Key);
    if (remote && bytesEqual(local, remote)) {
      info(`unchanged: ${r2Key}`);
      continue;
    }
    if (flags.dryRun) {
      info(`would upload ${r2Key}`);
      continue;
    }
    await r2Put(env, r2Key, fullSrc, "application/json", SCHEMA_CACHE_CONTROL);
    ok(`uploaded ${r2Key}`);
    uploaded++;
  }

  if (flags.dryRun) {
    info(colors.yellow("dry-run: no uploads performed"));
    return;
  }
  if (uploaded === 0) {
    ok("all schemas already up to date");
  } else {
    ok(`uploaded ${uploaded}/${SCHEMAS.length} schemas`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
