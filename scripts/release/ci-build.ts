#!/usr/bin/env -S deno run -A
// CI build half: runs on ONE native runner, builds that runner's host triple,
// and stages the artifacts + descriptors for the publish job (ci-publish.ts) to
// compose + sign + upload once. This is the GitHub Actions analogue of the local
// build-environment drivers (Podman/UTM): a dumb artifact producer emitting the
// same bundle/descriptor contract, so the two pipelines stay aligned.
//
// It builds core (always) + the desktop client (always, when Tauri keys are
// present) + Android (only with --android, on the Linux runner). It does build-
// time signing only (Tauri minisign for the client, the Java keystore for the
// APK) from secrets in the process env; it constructs the env directly rather
// than via loadOrSeedEnv, so the Ed25519 trust-root PRIVATE key never reaches a
// build runner. It writes the Ed25519 PUBLIC key into signing-keys.json so the
// compiled core embeds the key it verifies manifests with.
//
// Flags:
//   --channel=stable|latest   target channel (required; the workflow sets it)
//   --stage-dir=<path>         where to stage artifacts (default: ./stage)
//   --android                  also build + stage the Android APK(s) (Linux only)

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import {
  channelBinSuffix,
  colors,
  detectHostTriple,
  envFromProcess,
  fail,
  info,
  ok,
  parseChannelFlag,
  readCoreVersion,
  REPO_ROOT,
  step,
  writeSigningKeys,
} from "./lib.ts";
import { join } from "@std/path";
import { buildCoreArtifacts } from "./core.ts";
import { buildClientBundle } from "./client.ts";
import { buildAndroidBundle } from "./android.ts";
import {
  bundleCoreArtifacts,
  stageDistFile,
  writeAndroidDescriptor,
  writeBundle,
  writeClientDescriptor,
} from "./artifacts.ts";

async function main(): Promise<void> {
  const args = parseArgs(
    Deno.args.filter((a) => a !== "--"),
    {
      string: ["channel", "stage-dir"],
      boolean: ["android"],
      default: { android: false },
    },
  );
  const channel = parseChannelFlag(args.channel);
  const stageDir = args["stage-dir"] ? String(args["stage-dir"]) : join(REPO_ROOT, "stage");
  const suffix = channelBinSuffix(channel);
  const hostTriple = detectHostTriple();
  const version = await readCoreVersion();

  console.log(colors.bold(`\ntomat ci-build: ${channel} channel, ${hostTriple}\n`));

  const env = envFromProcess();
  // Bake the Ed25519 public key into the core binary (data/signing-keys.json) so
  // it can verify manifests at runtime. Must precede the core build.
  await writeSigningKeys(Deno.env.get("TOMAT_SIGNING_PUBLIC_KEY_B64")!);

  // Fresh staging dir per run.
  await Deno.remove(stageDir, { recursive: true }).catch(() => {});
  await ensureDir(stageDir);

  // --- core (always) ---
  step(`Building core for ${hostTriple}`);
  const coreBuilt = await buildCoreArtifacts([hostTriple], suffix);
  const bundle = bundleCoreArtifacts(coreBuilt, version, channel, [hostTriple]);
  await writeBundle(stageDir, bundle);
  for (const rec of bundle.records) await stageDistFile(stageDir, rec.relPath);
  ok(`staged ${bundle.records.length} core record(s)`);

  // --- desktop client (always, when Tauri keys are present) ---
  if (env.tauriUpdaterPublicKey && env.tauriUpdaterPrivateKey) {
    const descriptor = await buildClientBundle(env, channel);
    await writeClientDescriptor(stageDir, descriptor);
    await stageDistFile(stageDir, descriptor.relPath);
    await stageDistFile(stageDir, descriptor.sigRelPath);
    ok(`staged client bundle ${descriptor.filename}`);
  } else {
    info(colors.yellow("Tauri updater keys absent; skipping the client on this runner"));
  }

  // --- Android (Linux runner only, with --android) ---
  if (args.android) {
    if (!env.androidKeystoreB64) {
      fail(`--android given but TOMAT_ANDROID_KEYSTORE_B64 is not set in the env.`);
    }
    const descriptor = await buildAndroidBundle(env, channel);
    await writeAndroidDescriptor(stageDir, descriptor);
    for (const apk of descriptor.apks) await stageDistFile(stageDir, apk.relPath);
    ok(`staged ${descriptor.apks.length} APK(s)`);
  }

  console.log(
    "\n" + colors.green(colors.bold(`✓ ci-build complete`)) + `  staged under ${stageDir}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
