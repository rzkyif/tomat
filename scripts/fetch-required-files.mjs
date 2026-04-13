#!/usr/bin/env node

/**
 * fetch-required-files.mjs
 *
 * Downloads llama-server, whisper-server, and bun binaries from GitHub releases
 * and extracts them into src-tauri/binaries. Verifies every downloaded archive
 * against a committed SHA-256 manifest (src-tauri/binaries/checksums.json) to
 * protect against tampered releases or MITM. Also copies VAD runtime files
 * (Silero + ONNX Runtime WASM) from node_modules into static/vad/.
 *
 * Default mode: reads pinned versions from versions.json, downloads those
 * exact versions, and refuses to proceed if a downloaded archive's hash does
 * not match the committed manifest.
 *
 * Maintainer mode (--update): fetches the latest release tags from GitHub,
 * downloads, and writes both versions.json and checksums.json. Use this when
 * bumping upstream versions. The resulting files should be reviewed and
 * committed.
 */

import crypto from "crypto";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable, Transform } from "stream";

// ---------------------------------------------------------------------------
// Platform mapping
// ---------------------------------------------------------------------------

const PLATFORM_MAP = {
  "linux-arm64": {
    llamaAsset: "ubuntu-arm64",
    archiveExt: "tar.gz",
    isWindows: false,
    tauriTriple: "aarch64-unknown-linux-gnu",
    bunAsset: "linux-aarch64",
  },
  "linux-x86_64": {
    llamaAsset: "ubuntu-x64",
    archiveExt: "tar.gz",
    isWindows: false,
    tauriTriple: "x86_64-unknown-linux-gnu",
    bunAsset: "linux-x64",
  },
  "macos-arm64": {
    llamaAsset: "macos-arm64",
    archiveExt: "tar.gz",
    isWindows: false,
    tauriTriple: "aarch64-apple-darwin",
    bunAsset: "darwin-aarch64",
  },
  "macos-x86_64": {
    llamaAsset: "macos-x64",
    archiveExt: "tar.gz",
    isWindows: false,
    tauriTriple: "x86_64-apple-darwin",
    bunAsset: "darwin-x64",
  },
  "windows-arm64": {
    llamaAsset: "win-cpu-arm64",
    archiveExt: "zip",
    isWindows: true,
    tauriTriple: "aarch64-pc-windows-msvc",
    bunAsset: "windows-aarch64",
  },
  "windows-x64": {
    llamaAsset: "win-cpu-x64",
    archiveExt: "zip",
    isWindows: true,
    tauriTriple: "x86_64-pc-windows-msvc",
    bunAsset: "windows-x64",
  },
};

const WHISPER_REPO = "rzkyif/whisper-server-binaries";
const LLAMA_REPO = "ggml-org/llama.cpp";
const BUN_REPO = "oven-sh/bun";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const BINARIES_DIR = path.join(ROOT_DIR, "src-tauri", "binaries");
const VERSIONS_FILE = path.join(BINARIES_DIR, "versions.json");
const CHECKSUMS_FILE = path.join(BINARIES_DIR, "checksums.json");
const INSTALLED_FILE = path.join(BINARIES_DIR, ".installed.json");
const TEMP_DIR = path.join(BINARIES_DIR, ".tmp_binaries");

const VAD_WEB_PKG = path.join(ROOT_DIR, "node_modules", "@ricky0123", "vad-web");
const ORT_WEB_PKG = path.join(ROOT_DIR, "node_modules", "onnxruntime-web");
const VAD_DEST_DIR = path.join(ROOT_DIR, "static", "vad");

const VAD_FILES = [
  [path.join(VAD_WEB_PKG, "dist"), "silero_vad_v5.onnx"],
  [path.join(VAD_WEB_PKG, "dist"), "vad.worklet.bundle.min.js"],
  [path.join(ORT_WEB_PKG, "dist"), "ort-wasm-simd-threaded.wasm"],
  [path.join(ORT_WEB_PKG, "dist"), "ort-wasm-simd-threaded.jsep.wasm"],
  [path.join(ORT_WEB_PKG, "dist"), "ort-wasm-simd-threaded.mjs"],
];

// ---------------------------------------------------------------------------
// Bun sidecar runtime dependencies
// ---------------------------------------------------------------------------
// The bun-side server.js is bundled (see scripts/build-bun.mjs) but a few
// packages are kept external because they carry per-platform native binaries
// or are loaded relative to their own dist directory:
//
//   - onnxruntime-node: native NAPI binding used by transformers.js's CPU
//     execution provider. Only the host platform's binary is staged to keep
//     the shipped bundle small.
//   - onnxruntime-common: shared types/util package required by onnxruntime-node.
//   - kokoro-js voice tensors: kokoro-js loads `voices/<name>.bin` relative
//     to its own dist dir. We stage them so that, at runtime, server.js can
//     reach them via `../voices/...`.
//
// Tauri's bundle.resources ships these into the packaged app:
//   src-tauri/resources/node_modules/onnxruntime-node|common
//   src-tauri/voices
const ORT_NODE_PKG = path.join(ROOT_DIR, "node_modules", "onnxruntime-node");
const ORT_COMMON_PKG = path.join(ROOT_DIR, "node_modules", "onnxruntime-common");
const KOKORO_PKG = path.join(ROOT_DIR, "node_modules", "kokoro-js");
const SIDECAR_NODE_MODULES_DIR = path.join(ROOT_DIR, "src-tauri", "resources", "node_modules");
const SIDECAR_VOICES_DIR = path.join(ROOT_DIR, "src-tauri", "voices");

function hostOrtBinaryDir() {
  // onnxruntime-node lays out binaries as bin/napi-v3/<platform>/<arch>/
  // matching Node's process.platform / process.arch values exactly.
  return path.join("bin", "napi-v3", process.platform, process.arch);
}

function copyDir(src, dest, filter) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source directory does not exist: ${src}`);
  }
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (filter && !filter(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UPDATE_MODE = process.argv.includes("--update");

function log(msg) {
  console.log(`[fetch-required-files] ${msg}`);
}

function logError(msg) {
  console.error(`[fetch-required-files] ERROR: ${msg}`);
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "fetch-required-files-script",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function downloadFileWithHash(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": "fetch-required-files-script" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const hash = crypto.createHash("sha256");
  const hashTap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body), hashTap, fileStream);
  return hash.digest("hex");
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "pipe" });
}

function extractTarGz(tarPath, destDir) {
  ensureDir(destDir);
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: "pipe" });
}

function findFileRecursive(dir, fileName) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return fullPath;
    }
  }
  return null;
}

function findSharedLibraries(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSharedLibraries(fullPath));
    } else if (
      entry.name.endsWith(".dll") ||
      entry.name.endsWith(".so") ||
      entry.name.includes(".so.") ||
      entry.name.endsWith(".dylib") ||
      entry.name.endsWith(".metal")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

function findWhisperAsset(assets, platform) {
  return assets.find((a) => a.name.endsWith(`-${platform}.zip`));
}

function findLlamaAsset(assets, llamaAsset, archiveExt) {
  return assets.find((a) => a.name.endsWith(`-${llamaAsset}.${archiveExt}`));
}

function findBunAsset(assets, bunAsset) {
  return assets.find((a) => a.name === `bun-${bunAsset}.zip`);
}

// ---------------------------------------------------------------------------
// Release fetch: maintainer mode pulls latest; default mode uses a dummy
// structure and looks up assets from the pinned tag directly.
// ---------------------------------------------------------------------------

async function fetchLatestReleases() {
  log("Fetching latest release tags from GitHub...");
  const [whisper, llama, bun] = await Promise.all([
    fetchJSON(`https://api.github.com/repos/${WHISPER_REPO}/releases/latest`),
    fetchJSON(`https://api.github.com/repos/${LLAMA_REPO}/releases/latest`),
    fetchJSON(`https://api.github.com/repos/${BUN_REPO}/releases/latest`),
  ]);
  return { whisper, llama, bun };
}

async function fetchReleaseByTag(repo, tag) {
  return fetchJSON(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
}

// ---------------------------------------------------------------------------
// Verification / hash manifest
// ---------------------------------------------------------------------------

function verifyOrRecordHash(checksums, binary, platform, version, actualHex) {
  const entry = checksums[binary] ?? { version: null, platforms: {} };
  const expected = entry.version === version ? entry.platforms[platform] : undefined;

  if (UPDATE_MODE) {
    if (entry.version !== version) {
      entry.version = version;
      entry.platforms = {};
    }
    entry.platforms[platform] = actualHex;
    checksums[binary] = entry;
    log(`  [update] recorded ${binary} ${platform}: ${actualHex.slice(0, 12)}...`);
    return;
  }

  if (!expected) {
    throw new Error(
      `No committed SHA-256 for ${binary} ${platform} at version ${version}. ` +
        `Run 'bun run fetch --update' (maintainer mode) to regenerate checksums.json.`,
    );
  }
  if (expected !== actualHex) {
    throw new Error(
      `SHA-256 mismatch for ${binary} ${platform}:\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actualHex}\n` +
        `Aborting - downloaded archive does not match committed manifest.`,
    );
  }
  log(`  [verify] ${binary} ${platform} OK`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureDir(BINARIES_DIR);

  // Resolve target versions.
  let targetVersions;
  let releases = { whisper: null, llama: null, bun: null };

  if (UPDATE_MODE) {
    releases = await fetchLatestReleases();
    targetVersions = {
      whisper: releases.whisper.tag_name,
      llama: releases.llama.tag_name,
      bun: releases.bun.tag_name,
    };
    log(
      `--update mode: targeting whisper=${targetVersions.whisper}, ` +
        `llama=${targetVersions.llama}, bun=${targetVersions.bun}`,
    );
  } else {
    targetVersions = readJSON(VERSIONS_FILE, null);
    if (!targetVersions) {
      throw new Error(
        `${VERSIONS_FILE} missing. Run 'bun run fetch --update' first to pin versions.`,
      );
    }
    log(
      `Pinned: whisper=${targetVersions.whisper}, ` +
        `llama=${targetVersions.llama}, bun=${targetVersions.bun}`,
    );
  }

  // Load hash manifest.
  const checksums = readJSON(CHECKSUMS_FILE, {});
  if (!UPDATE_MODE && Object.keys(checksums).length === 0) {
    throw new Error(
      `${CHECKSUMS_FILE} missing or empty. Run 'bun run fetch --update' to populate it.`,
    );
  }

  // Track what's currently extracted on disk, to skip redundant work.
  const installed = readJSON(INSTALLED_FILE, {});

  // VAD files: trust node_modules (lockfile integrity).
  const vadWebVersion = JSON.parse(
    fs.readFileSync(path.join(VAD_WEB_PKG, "package.json"), "utf-8"),
  ).version;
  const onnxWebVersion = JSON.parse(
    fs.readFileSync(path.join(ORT_WEB_PKG, "package.json"), "utf-8"),
  ).version;

  const needVad = installed.vadWeb !== vadWebVersion || installed.onnxruntime !== onnxWebVersion;

  // Bun sidecar deps: track by package version + host platform so a platform
  // switch (e.g. cargo build --target across architectures) re-stages the
  // correct native binary.
  const ortNodeVersion = JSON.parse(
    fs.readFileSync(path.join(ORT_NODE_PKG, "package.json"), "utf-8"),
  ).version;
  const ortCommonVersion = JSON.parse(
    fs.readFileSync(path.join(ORT_COMMON_PKG, "package.json"), "utf-8"),
  ).version;
  const kokoroVersion = JSON.parse(
    fs.readFileSync(path.join(KOKORO_PKG, "package.json"), "utf-8"),
  ).version;
  const ortHostKey = `${ortNodeVersion}-${process.platform}-${process.arch}`;
  const needOrtNode = installed.onnxruntimeNode !== ortHostKey;
  const needOrtCommon = installed.onnxruntimeCommon !== ortCommonVersion;
  const needKokoroVoices = installed.kokoroVoices !== kokoroVersion;

  // In --update mode, always re-download every binary so hashes are recorded
  // for all of them - otherwise a binary that's already at the latest version
  // on disk would be skipped and its entry would never appear in checksums.json.
  const needWhisper = UPDATE_MODE || installed.whisper !== targetVersions.whisper;
  const needLlama = UPDATE_MODE || installed.llama !== targetVersions.llama;
  const needBun = UPDATE_MODE || installed.bun !== targetVersions.bun;

  if (
    !needWhisper &&
    !needLlama &&
    !needBun &&
    !needVad &&
    !needOrtNode &&
    !needOrtCommon &&
    !needKokoroVoices
  ) {
    log("All binaries, VAD files, and bun sidecar deps are up to date.");
    return;
  }

  if (needVad) {
    log("Copying VAD files from node_modules...");
    ensureDir(VAD_DEST_DIR);
    for (const [srcDir, file] of VAD_FILES) {
      fs.copyFileSync(path.join(srcDir, file), path.join(VAD_DEST_DIR, file));
      log(`  Copied ${file}`);
    }
    installed.vadWeb = vadWebVersion;
    installed.onnxruntime = onnxWebVersion;
  }

  if (needOrtNode) {
    log(`Staging onnxruntime-node ${ortNodeVersion} for ${process.platform}/${process.arch}...`);
    const dest = path.join(SIDECAR_NODE_MODULES_DIR, "onnxruntime-node");
    rmDir(dest);
    ensureDir(dest);
    const hostBinDir = hostOrtBinaryDir();
    // Skip every other platform's native binary to keep the bundle small.
    copyDir(ORT_NODE_PKG, dest, (src) => {
      const rel = path.relative(ORT_NODE_PKG, src);
      if (rel === "node_modules" || rel.startsWith("node_modules" + path.sep)) {
        return false;
      }
      if (rel === "bin" || rel.startsWith("bin" + path.sep)) {
        return rel === "bin" || rel.startsWith(hostBinDir) || hostBinDir.startsWith(rel);
      }
      return true;
    });
    installed.onnxruntimeNode = ortHostKey;
    log(`  Staged onnxruntime-node (host binary only)`);
  }

  if (needOrtCommon) {
    log(`Staging onnxruntime-common ${ortCommonVersion}...`);
    const dest = path.join(SIDECAR_NODE_MODULES_DIR, "onnxruntime-common");
    rmDir(dest);
    ensureDir(dest);
    copyDir(ORT_COMMON_PKG, dest, (src) => {
      const rel = path.relative(ORT_COMMON_PKG, src);
      return rel !== "node_modules" && !rel.startsWith("node_modules" + path.sep);
    });
    installed.onnxruntimeCommon = ortCommonVersion;
    log(`  Staged onnxruntime-common`);
  }

  if (needKokoroVoices) {
    log(`Staging kokoro-js voices ${kokoroVersion}...`);
    rmDir(SIDECAR_VOICES_DIR);
    copyDir(path.join(KOKORO_PKG, "voices"), SIDECAR_VOICES_DIR);
    installed.kokoroVoices = kokoroVersion;
    log(`  Staged kokoro-js voices`);
  }

  // In default mode, we fetch release metadata per-tag to discover asset URLs
  // matching the pinned version - not "latest".
  if (!UPDATE_MODE) {
    const [w, l, b] = await Promise.all([
      needWhisper ? fetchReleaseByTag(WHISPER_REPO, targetVersions.whisper) : null,
      needLlama ? fetchReleaseByTag(LLAMA_REPO, targetVersions.llama) : null,
      needBun ? fetchReleaseByTag(BUN_REPO, targetVersions.bun) : null,
    ]);
    releases = { whisper: w, llama: l, bun: b };
  }

  ensureDir(TEMP_DIR);

  try {
    for (const [platform, config] of Object.entries(PLATFORM_MAP)) {
      const outputDir = BINARIES_DIR;
      ensureDir(outputDir);

      const whisperExeName = config.isWindows
        ? `tomat-whisper-server-${config.tauriTriple}.exe`
        : `tomat-whisper-server-${config.tauriTriple}`;
      const llamaExeName = config.isWindows
        ? `tomat-llama-server-${config.tauriTriple}.exe`
        : `tomat-llama-server-${config.tauriTriple}`;
      const bunExeName = config.isWindows
        ? `tomat-tools-server-${config.tauriTriple}.exe`
        : `tomat-tools-server-${config.tauriTriple}`;

      if (needBun) {
        const bunAsset = findBunAsset(releases.bun.assets, config.bunAsset);
        if (!bunAsset) {
          logError(
            `No bun asset found for platform: ${platform} (searching for: bun-${config.bunAsset}.zip)`,
          );
        } else {
          log(`Downloading bun for ${platform}...`);
          const bunZipPath = path.join(TEMP_DIR, bunAsset.name);
          const hex = await downloadFileWithHash(bunAsset.browser_download_url, bunZipPath);
          verifyOrRecordHash(checksums, "bun", platform, targetVersions.bun, hex);

          log(`Extracting bun for ${platform}...`);
          const bunExtractDir = path.join(TEMP_DIR, `bun-${platform}`);
          extractZip(bunZipPath, bunExtractDir);

          const binaryName = config.isWindows ? "bun.exe" : "bun";
          const binaryPath = findFileRecursive(bunExtractDir, binaryName);
          if (binaryPath) {
            const destBinaryPath = path.join(outputDir, bunExeName);
            fs.copyFileSync(binaryPath, destBinaryPath);
            if (!config.isWindows) fs.chmodSync(destBinaryPath, 0o755);
            log(`  Copied ${bunExeName}`);
          } else {
            logError(`  Could not find ${binaryName} in bun archive for ${platform}`);
          }

          fs.unlinkSync(bunZipPath);
          rmDir(bunExtractDir);
        }
      }

      if (needWhisper) {
        const whisperAsset = findWhisperAsset(releases.whisper.assets, platform);
        if (!whisperAsset) {
          logError(`No whisper-server asset found for platform: ${platform}`);
        } else {
          log(`Downloading whisper-server for ${platform}...`);
          const whisperZipPath = path.join(TEMP_DIR, whisperAsset.name);
          const hex = await downloadFileWithHash(whisperAsset.browser_download_url, whisperZipPath);
          verifyOrRecordHash(checksums, "whisper", platform, targetVersions.whisper, hex);

          log(`Extracting whisper-server for ${platform}...`);
          const whisperExtractDir = path.join(TEMP_DIR, `whisper-${platform}`);
          extractZip(whisperZipPath, whisperExtractDir);

          const binaryName = config.isWindows ? "whisper-server.exe" : "whisper-server";
          const binaryPath = findFileRecursive(whisperExtractDir, binaryName);
          if (binaryPath) {
            const destBinaryPath = path.join(outputDir, whisperExeName);
            fs.copyFileSync(binaryPath, destBinaryPath);
            if (!config.isWindows) fs.chmodSync(destBinaryPath, 0o755);
            log(`  Copied ${whisperExeName}`);
          } else {
            logError(`  Could not find ${binaryName} in whisper archive for ${platform}`);
          }

          fs.unlinkSync(whisperZipPath);
          rmDir(whisperExtractDir);
        }
      }

      if (needLlama) {
        const llamaAsset = findLlamaAsset(
          releases.llama.assets,
          config.llamaAsset,
          config.archiveExt,
        );
        if (!llamaAsset) {
          logError(
            `No llama.cpp asset found for platform: ${platform} (searching for: ${config.llamaAsset})`,
          );
        } else {
          log(`Downloading llama.cpp for ${platform}...`);
          const llamaArchivePath = path.join(TEMP_DIR, llamaAsset.name);
          const hex = await downloadFileWithHash(llamaAsset.browser_download_url, llamaArchivePath);
          verifyOrRecordHash(checksums, "llama", platform, targetVersions.llama, hex);

          log(`Extracting llama-server for ${platform}...`);
          const llamaExtractDir = path.join(TEMP_DIR, `llama-${platform}`);
          ensureDir(llamaExtractDir);

          if (config.archiveExt === "zip") {
            extractZip(llamaArchivePath, llamaExtractDir);
          } else {
            extractTarGz(llamaArchivePath, llamaExtractDir);
          }

          const binaryName = config.isWindows ? "llama-server.exe" : "llama-server";
          const binaryPath = findFileRecursive(llamaExtractDir, binaryName);

          if (binaryPath) {
            const destBinaryPath = path.join(outputDir, llamaExeName);
            fs.copyFileSync(binaryPath, destBinaryPath);
            if (!config.isWindows) fs.chmodSync(destBinaryPath, 0o755);
            log(`  Copied ${llamaExeName}`);
          } else {
            logError(`  Could not find ${binaryName} in llama.cpp archive for ${platform}`);
          }

          const sharedLibs = findSharedLibraries(llamaExtractDir);
          if (sharedLibs.length > 0) {
            const libDir = path.join(outputDir, config.tauriTriple);
            ensureDir(libDir);
            for (const libPath of sharedLibs) {
              const libName = path.basename(libPath);
              const destLibPath = path.join(libDir, libName);
              fs.copyFileSync(libPath, destLibPath);
              log(`  Copied ${libName} to ${config.tauriTriple}/`);
            }
          }

          fs.unlinkSync(llamaArchivePath);
          rmDir(llamaExtractDir);
        }
      }
    }

    // Persist state: installed tracks what's on disk; versions.json and
    // checksums.json are committed artifacts updated only in --update mode.
    if (needWhisper) installed.whisper = targetVersions.whisper;
    if (needLlama) installed.llama = targetVersions.llama;
    if (needBun) installed.bun = targetVersions.bun;
    writeJSON(INSTALLED_FILE, installed);

    if (UPDATE_MODE) {
      writeJSON(VERSIONS_FILE, targetVersions);
      writeJSON(CHECKSUMS_FILE, checksums);
      log("Wrote versions.json and checksums.json - review and commit them.");
    }
  } finally {
    rmDir(TEMP_DIR);
  }

  log("Done!");
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
