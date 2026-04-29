#!/usr/bin/env bun

/**
 * build-bun.mjs
 *
 * Runs the same `bun build` invocations that used to live inline in
 * package.json's `build:bun` script, but writes the outputs into
 * src/tauri/resources/ only when the content actually changed.
 *
 * Why: tauri-build emits `cargo:rerun-if-changed` for every file listed in
 * tauri.conf.json's bundle.resources array (which includes server.js and
 * runtime.js). `bun build --outfile=X` always updates X's mtime, so
 * the plain invocation forced Cargo to invalidate its build-script cache on
 * every `bun dev` run — even when the bundled output was byte-identical.
 * This script builds to a temp file, compares, and only renames over the
 * target if the new bytes differ; otherwise the existing file's mtime is
 * preserved and Cargo's incremental cache stays valid.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const RESOURCES = resolve(ROOT, "src/tauri/resources");
const USER_TOOLKITS_DIR = resolve(homedir(), ".tomat/toolkits");

mkdirSync(RESOURCES, { recursive: true });

const BUILDS = [
  {
    entry: "src/bun/index.ts",
    outfile: "server.js",
    external: [
      "onnxruntime-node",
      "onnxruntime-common",
      "kokoro-js",
      "@huggingface/transformers",
      "phonemizer",
    ],
  },
  {
    entry: "src/bun/toolkits/worker/runtime.ts",
    outfile: "runtime.js",
    external: [],
  },
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

for (const build of BUILDS) {
  const target = resolve(RESOURCES, build.outfile);
  const tmp = resolve(RESOURCES, `.${build.outfile}.tmp`);
  const externalFlags = build.external.flatMap((m) => ["--external", m]);
  const args = [
    "build",
    build.entry,
    `--outfile=${tmp}`,
    "--target=bun",
    "--minify",
    ...externalFlags,
  ];

  const proc = Bun.spawnSync({
    cmd: ["bun", ...args],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });

  if (proc.exitCode !== 0) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist if bun build failed early
    }
    process.exit(proc.exitCode ?? 1);
  }

  const newBytes = readFileSync(tmp);
  let changed = true;
  if (existsSync(target)) {
    const existingBytes = readFileSync(target);
    if (existingBytes.length === newBytes.length && sha256(existingBytes) === sha256(newBytes)) {
      changed = false;
    }
  }

  if (changed) {
    renameSync(tmp, target);
    console.log(`[build-bun] wrote ${build.outfile} (${newBytes.length} bytes)`);
  } else {
    unlinkSync(tmp);
    console.log(
      `[build-bun] ${build.outfile} unchanged (${newBytes.length} bytes, mtime preserved)`,
    );
  }
}

// Sync the toolkit author SDK into ~/.tomat/toolkits/ so dev toolkits get
// autocomplete on ToolContext / ToolkitMetadata without waiting for the Rust
// seed command to fire on first app launch.
{
  const sdkSrc = resolve(ROOT, "src/toolkits/toolkits.d.ts");
  if (existsSync(sdkSrc)) {
    mkdirSync(USER_TOOLKITS_DIR, { recursive: true });
    const sdkDst = resolve(USER_TOOLKITS_DIR, "toolkits.d.ts");
    copyFileSync(sdkSrc, sdkDst);
    console.log(`[build-bun] synced SDK to ${sdkDst}`);
  }
}
