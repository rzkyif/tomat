#!/usr/bin/env -S deno run -A
// Starts the Astro dev server for the website. Stages the install scripts
// and tools-json-schema into public/ first so they're served at the same
// paths they will be in production.
//
// Manifests are NOT staged in dev — they require the Ed25519 signing key
// from `.env` and the matching release binaries on R2, neither of which a
// dev session needs. Run `deno task website:deploy --dry-run` if you want
// to exercise the full manifest pipeline locally.

import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { copy } from "jsr:@std/fs@^1/copy";
import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@^1";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../..");
const WEBSITE_DIR = join(REPO_ROOT, "packages/tomat-website");
const INSTALL_DIR = join(REPO_ROOT, "scripts/install");
const SHARED_DIR = join(REPO_ROOT, "packages/tomat-shared");
const PUBLIC_DIR = join(WEBSITE_DIR, "public");

async function copyFile(src: string, dst: string): Promise<void> {
  await ensureDir(dirname(dst));
  await copy(src, dst, { overwrite: true });
}

console.log("staging public/install + public/schemas");
await copyFile(
  join(INSTALL_DIR, "core.sh"),
  join(PUBLIC_DIR, "install/core.sh"),
);
await copyFile(
  join(INSTALL_DIR, "core.ps1"),
  join(PUBLIC_DIR, "install/core.ps1"),
);
await copyFile(
  join(SHARED_DIR, "src/tools-json-schema.json"),
  join(PUBLIC_DIR, "schemas/tools-v1.json"),
);

console.log("starting astro dev");
const cmd = new Deno.Command("deno", {
  args: ["run", "-A", "npm:astro@^5", "dev"],
  cwd: WEBSITE_DIR,
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
