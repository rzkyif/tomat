#!/usr/bin/env -S deno run -A
// Starts the Astro dev server for the website. No staging. Release artifacts
// (manifests, install scripts, schemas) live on R2 at get.au.tomat.ing now,
// not on the Worker, so the landing page is fully self-contained.

import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@^1";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../..");
const WEBSITE_DIR = join(REPO_ROOT, "packages/tomat-website");

const cmd = new Deno.Command("deno", {
  args: ["run", "-A", "npm:astro@^5", "dev"],
  cwd: WEBSITE_DIR,
  stdout: "inherit",
  stderr: "inherit",
});
Deno.exit((await cmd.output()).code);
