#!/usr/bin/env -S deno run -A
// release:scripts — uploads scripts/install/*.{sh,ps1} to R2 under install/.
// Per-script idempotent: fetches the remote body and only re-uploads files
// whose content differs.
//
// Flags:
//   --dry-run   probe + report only; no uploads
//   --force     upload every file regardless of equality
//   --help

import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { join } from "jsr:@std/path@^1";
import {
  bytesEqual,
  colors,
  fail,
  fetchR2Bytes,
  info,
  INSTALL_DIR,
  loadOrSeedEnv,
  ok,
  r2Put,
  step,
} from "./lib.ts";

const INSTALL_SCRIPTS: Array<{ name: string; contentType: string }> = [
  { name: "core.sh", contentType: "text/x-shellscript" },
  { name: "core-uninstall.sh", contentType: "text/x-shellscript" },
  { name: "client.sh", contentType: "text/x-shellscript" },
  { name: "client-uninstall.sh", contentType: "text/x-shellscript" },
  { name: "core.ps1", contentType: "application/x-powershell" },
  { name: "core-uninstall.ps1", contentType: "application/x-powershell" },
  { name: "client.ps1", contentType: "application/x-powershell" },
  { name: "client-uninstall.ps1", contentType: "application/x-powershell" },
];

const SCRIPT_CACHE_CONTROL = "public, max-age=300";

interface Flags {
  dryRun: boolean;
  force: boolean;
}

function parseFlags(): Flags {
  // Strip the bare `--` token that `deno task <name> -- ...` passes through.
  const args = parseArgs(Deno.args.filter((a) => a !== "--"), {
    boolean: ["dry-run", "force", "help"],
    default: { "dry-run": false, "force": false, "help": false },
  });
  if (args.help) {
    console.log(`Usage: deno task release:scripts [flags]

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

  step(`Syncing ${INSTALL_SCRIPTS.length} install scripts to R2`);
  let uploaded = 0;
  for (const { name, contentType } of INSTALL_SCRIPTS) {
    const src = join(INSTALL_DIR, name);
    const r2Key = `install/${name}`;
    const local = await Deno.readFile(src);
    const remote = flags.force ? null : await fetchR2Bytes(env, r2Key);
    if (remote && bytesEqual(local, remote)) {
      info(`unchanged: ${r2Key}`);
      continue;
    }
    if (flags.dryRun) {
      info(`would upload ${r2Key}`);
      continue;
    }
    await r2Put(env, r2Key, src, contentType, SCRIPT_CACHE_CONTROL);
    ok(`uploaded ${r2Key}`);
    uploaded++;
  }

  if (flags.dryRun) {
    info(colors.yellow("dry-run: no uploads performed"));
    return;
  }
  if (uploaded === 0) {
    ok("all install scripts already up to date");
  } else {
    ok(`uploaded ${uploaded}/${INSTALL_SCRIPTS.length} install scripts`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
