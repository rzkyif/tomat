#!/usr/bin/env node

/**
 * build-bun.mjs
 *
 * Bundles src-bun/index.ts into src-tauri/resources/server.js and patches the
 * embedded `__dirname` for `kokoro-js` so its voice file lookup resolves
 * relative to server.js at runtime instead of the build host's absolute
 * node_modules path.
 *
 * onnxruntime-node and onnxruntime-common are kept external because the former
 * carries a per-platform native .node binding and the latter is required by
 * the former. Both are staged into src-tauri/resources/node_modules/ by the
 * fetch-required-files.mjs script so Bun's runtime resolution finds them next
 * to server.js.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "src-tauri", "resources", "server.js");

execSync(
  [
    "bun build src-bun/index.ts",
    "--outfile=src-tauri/resources/server.js",
    "--target=bun",
    "--minify",
    "--external onnxruntime-node",
    "--external onnxruntime-common",
  ].join(" "),
  { cwd: ROOT, stdio: "inherit" },
);

let bundle = fs.readFileSync(SERVER, "utf8");

// Bun's bundler hardcodes each inlined module's `__dirname` to the source
// path on the build host. kokoro-js uses that to find `../voices/<name>.bin`,
// which on an end-user machine wouldn't resolve. Rewrite the assignment so
// kokoro-js looks one level up from the running server.js, where
// fetch-required-files.mjs stages the bundled voice tensors.
const before = bundle;
bundle = bundle.replace(/__dirname="[^"]*kokoro-js\/dist"/g, "__dirname=import.meta.dir");
if (bundle === before) {
  console.warn(
    "[build-bun] WARNING: kokoro-js __dirname pattern not found; voice lookup may fail at runtime",
  );
} else {
  console.log("[build-bun] patched kokoro-js __dirname for voice resolution");
}

fs.writeFileSync(SERVER, bundle);
