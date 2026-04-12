#!/usr/bin/env node

/**
 * fetch-required-files.mjs
 *
 * Downloads the latest llama-server, whisper-server, and bun binaries from GitHub,
 * extracts them into src-tauri/binaries, and tracks versions
 * in src-tauri/binaries/versions.json to avoid redundant downloads.
 *
 * Also copies VAD runtime files (Silero model + ONNX Runtime WASM) from
 * node_modules into static/vad/, re-copying only when package versions change.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// ---------------------------------------------------------------------------
// Platform mapping: whisper-server platform -> llama.cpp asset search string
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
const TEMP_DIR = path.join(BINARIES_DIR, ".tmp_binaries");

const VAD_WEB_PKG = path.join(ROOT_DIR, "node_modules", "@ricky0123", "vad-web");
const ORT_WEB_PKG = path.join(ROOT_DIR, "node_modules", "onnxruntime-web");
const VAD_DEST_DIR = path.join(ROOT_DIR, "static", "vad");

// Files to copy: [srcDir, filename]
const VAD_FILES = [
  [path.join(VAD_WEB_PKG, "dist"), "silero_vad_v5.onnx"],
  [path.join(VAD_WEB_PKG, "dist"), "vad.worklet.bundle.min.js"],
  [path.join(ORT_WEB_PKG, "dist"), "ort-wasm-simd-threaded.wasm"],
  [path.join(ORT_WEB_PKG, "dist"), "ort-wasm-simd-threaded.jsep.wasm"],
  [path.join(ORT_WEB_PKG, "dist"), "ort-wasm-simd-threaded.mjs"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": "fetch-required-files-script" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body), fileStream);
}

function readVersions() {
  try {
    return JSON.parse(fs.readFileSync(VERSIONS_FILE, "utf-8"));
  } catch {
    return { llama: null, whisper: null, bun: null, vadWeb: null, onnxruntime: null };
  }
}

function writeVersions(versions) {
  fs.mkdirSync(path.dirname(VERSIONS_FILE), { recursive: true });
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(versions, null, 2) + "\n");
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Checking for latest versions...");

  const [whisperRelease, llamaRelease, bunRelease] = await Promise.all([
    fetchJSON(`https://api.github.com/repos/${WHISPER_REPO}/releases/latest`),
    fetchJSON(`https://api.github.com/repos/${LLAMA_REPO}/releases/latest`),
    fetchJSON(`https://api.github.com/repos/${BUN_REPO}/releases/latest`),
  ]);

  const latestWhisperVersion = whisperRelease.tag_name;
  const latestLlamaVersion = llamaRelease.tag_name;
  const latestBunVersion = bunRelease.tag_name;

  log(`Latest whisper-server: ${latestWhisperVersion}`);
  log(`Latest llama.cpp:      ${latestLlamaVersion}`);
  log(`Latest bun:            ${latestBunVersion}`);

  const currentVersions = readVersions();
  log(`Current whisper-server: ${currentVersions.whisper || "(none)"}`);
  log(`Current llama.cpp:      ${currentVersions.llama || "(none)"}`);
  log(`Current bun:            ${currentVersions.bun || "(none)"}`);

  const needWhisper = currentVersions.whisper !== latestWhisperVersion;
  const needLlama = currentVersions.llama !== latestLlamaVersion;
  const needBun = currentVersions.bun !== latestBunVersion;

  // --- VAD files ---
  const vadWebVersion = JSON.parse(
    fs.readFileSync(path.join(VAD_WEB_PKG, "package.json"), "utf-8"),
  ).version;
  const onnxWebVersion = JSON.parse(
    fs.readFileSync(path.join(ORT_WEB_PKG, "package.json"), "utf-8"),
  ).version;

  log(`Installed @ricky0123/vad-web: ${vadWebVersion}`);
  log(`Installed onnxruntime-web:    ${onnxWebVersion}`);
  log(`Current  @ricky0123/vad-web:  ${currentVersions.vadWeb || "(none)"}`);
  log(`Current  onnxruntime-web:     ${currentVersions.onnxruntime || "(none)"}`);

  const needVad =
    currentVersions.vadWeb !== vadWebVersion || currentVersions.onnxruntime !== onnxWebVersion;

  if (!needWhisper && !needLlama && !needBun && !needVad) {
    log("All files are up to date. Nothing to do.");
    return;
  }

  // --- Copy VAD files from node_modules ---
  if (needVad) {
    log("Copying VAD files from node_modules...");
    ensureDir(VAD_DEST_DIR);
    for (const [srcDir, file] of VAD_FILES) {
      fs.copyFileSync(path.join(srcDir, file), path.join(VAD_DEST_DIR, file));
      log(`  Copied ${file}`);
    }
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

      // --- Bun ---
      if (needBun) {
        const bunAsset = findBunAsset(bunRelease.assets, config.bunAsset);
        if (!bunAsset) {
          logError(
            `No bun asset found for platform: ${platform} (searching for: bun-${config.bunAsset}.zip)`,
          );
        } else {
          log(`Downloading bun for ${platform}...`);
          const bunZipPath = path.join(TEMP_DIR, bunAsset.name);
          await downloadFile(bunAsset.browser_download_url, bunZipPath);

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

      // --- Whisper-server ---
      if (needWhisper) {
        const whisperAsset = findWhisperAsset(whisperRelease.assets, platform);
        if (!whisperAsset) {
          logError(`No whisper-server asset found for platform: ${platform}`);
        } else {
          log(`Downloading whisper-server for ${platform}...`);
          const whisperZipPath = path.join(TEMP_DIR, whisperAsset.name);
          await downloadFile(whisperAsset.browser_download_url, whisperZipPath);

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

      // --- Llama-server ---
      if (needLlama) {
        const llamaAsset = findLlamaAsset(
          llamaRelease.assets,
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
          await downloadFile(llamaAsset.browser_download_url, llamaArchivePath);

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

            if (!config.isWindows) {
              fs.chmodSync(destBinaryPath, 0o755);
            }

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

    const newVersions = {
      whisper: needWhisper ? latestWhisperVersion : currentVersions.whisper,
      llama: needLlama ? latestLlamaVersion : currentVersions.llama,
      bun: needBun ? latestBunVersion : currentVersions.bun,
      vadWeb: needVad ? vadWebVersion : currentVersions.vadWeb,
      onnxruntime: needVad ? onnxWebVersion : currentVersions.onnxruntime,
    };
    writeVersions(newVersions);
    log(
      `Updated versions.json: whisper=${newVersions.whisper}, llama=${newVersions.llama}, bun=${newVersions.bun}, vadWeb=${newVersions.vadWeb}, onnxruntime=${newVersions.onnxruntime}`,
    );
  } finally {
    rmDir(TEMP_DIR);
  }

  log("Done!");
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
