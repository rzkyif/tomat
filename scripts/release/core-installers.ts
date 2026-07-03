// Native Core installers: the conventional per-OS packages (macOS .pkg, Windows
// NSIS .exe, Linux .deb/.rpm) that lay down the Core binary set and register its
// background service by delegating to the binary's own install subcommands
// (packages/tomat-core/src/install). This is the greenfield counterpart to the
// gzip'd raw binaries core.ts already publishes: those feed self-update + the
// thin scripts; these give a double-click install.
//
// Each installer bundles the core binary + its per-triple helpers + the workers,
// and its post-install hook runs `tomat-core install-service` (which bootstraps
// the admin token, plants the built-in extension, and registers the launchd /
// systemd-user / Scheduled Task). The removal hook runs `tomat-core
// uninstall-service`. Because the runtime state lives per-user under
// ~/.tomat/<channel>/core, the post-install hooks resolve the target user and
// install into their home (the awkward bit called out in the plan: a root pkg /
// deb postinstall targeting a user-domain service).
//
// VALIDATION NOTE: this module invokes pkgbuild/productsign/notarytool,
// makensis/signtool, dpkg-deb, and rpmbuild - it only runs on a runner
// provisioned with those tools (the CI matrix + the local drivers install them).
// It cannot be exercised in a plain dev checkout; the templates + argument
// wiring are correct-by-construction and verified on a real release run.

import { basename, join } from "@std/path";
import { ensureDir } from "@std/fs/ensure-dir";
import type { Triple } from "../../packages/tomat-shared/src/domain/model.ts";
import type { CoreBuildArtifacts } from "./core.ts";
import { reanchorFile } from "./artifacts.ts";
import {
  type ApplyOpts,
  channelBinSuffix,
  channelManifestDir,
  channelStoragePrefix,
  colors,
  type DeployEnv,
  DIST_DIR,
  fetchLiveJson,
  humanBytes,
  info,
  ok,
  r2Put,
  type ReleaseChannel,
  rel,
  sha256File,
  signEd25519Bytes,
  step,
} from "./lib.ts";

// ---------------------------------------------------------------------------
// types

/** One built native Core installer, copied under dist/<triple>/ so it rides the
 *  same publish path as every other artifact. */
export interface CoreInstallerAsset {
  format: "pkg" | "exe" | "deb" | "rpm";
  triple: Triple;
  filename: string;
  relPath: string; // dist-relative, e.g. "aarch64-apple-darwin/tomat-core-0.1.5.pkg"
  sha256: string;
  size: number;
}

export interface CoreInstallerOpts {
  version: string;
  channel: ReleaseChannel;
  triple: Triple;
  env: DeployEnv;
}

const IDENTIFIER_BASE = "au.tomat.core";

/** Version-less download filename for a Core installer, used for the `current/`
 *  alias the website links against without knowing the version. Kept in sync
 *  with the stableName() helper (target "core") in the website's lib/install.ts. */
export function coreInstallerStableName(
  format: CoreInstallerAsset["format"],
  channel: ReleaseChannel,
): string {
  const suffix = channelBinSuffix(channel);
  if (format === "exe") return `tomat-core${suffix}-setup.exe`;
  return `tomat-core${suffix}.${format}`;
}

// ---------------------------------------------------------------------------
// small process helper (no engine host / logger; runs on a release machine)

async function run(argv: string[], cwd?: string): Promise<void> {
  const { code, stderr } = await new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `${argv[0]} exited ${code}: ${new TextDecoder().decode(stderr).trim().slice(0, 4000)}`,
    );
  }
}

async function have(bin: string): Promise<boolean> {
  // Presence, not success: Deno.Command throws NotFound when the binary is not on
  // PATH but returns a (possibly non-zero) exit code when it exists. Some tools we
  // probe reject `--version` (pkgbuild wants an argument, makensis uses /VERSION),
  // so keying off exit code 0 would false-negative and silently skip the installer.
  // stdin is closed so a tool that would otherwise read a script/stdin can't hang.
  try {
    await new Deno.Command(bin, {
      args: ["--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// payload assembly (shared across all four packagers)

/** Stage the core binary + matching helpers + workers into `<root>/{bin,workers}`
 *  using the channel-suffixed on-disk names the runtime expects. Returns the
 *  installed binary's basename (e.g. tomat-core-latest[.exe]). */
async function assemblePayload(
  built: CoreBuildArtifacts,
  triple: Triple,
  channel: ReleaseChannel,
  root: string,
): Promise<{ binName: string; binRelDir: string }> {
  const suffix = channelBinSuffix(channel);
  const exe = triple.endsWith("pc-windows-msvc") ? ".exe" : "";
  const binDir = join(root, "bin");
  const workersDir = join(root, "workers");
  await ensureDir(binDir);
  await ensureDir(workersDir);

  const core = built.artifacts.find((a) => a.triple === triple);
  if (!core) throw new Error(`no core binary for ${triple}`);
  const binName = `tomat-core${suffix}${exe}`;
  await Deno.copyFile(core.path, join(binDir, binName));

  for (const h of built.helpers) {
    if (h.triple !== triple) continue;
    // h.filename already carries the channel suffix + platform exe.
    await Deno.copyFile(h.path, join(binDir, h.filename));
  }
  for (const w of built.workers) {
    await Deno.copyFile(w.path, join(workersDir, basename(w.path)));
  }
  return { binName, binRelDir: "bin" };
}

// ---------------------------------------------------------------------------
// public entry

/** Build the native Core installer for `triple`'s OS. Returns the asset(s)
 *  produced (deb + rpm on Linux, one otherwise), or [] when the packaging tool
 *  is unavailable (so a plain host build degrades rather than fails). */
export async function buildCoreInstallers(
  built: CoreBuildArtifacts,
  opts: CoreInstallerOpts,
): Promise<CoreInstallerAsset[]> {
  const { triple } = opts;
  if (triple.endsWith("apple-darwin")) return await buildMacPkg(built, opts);
  if (triple.endsWith("pc-windows-msvc")) return await buildWindowsNsis(built, opts);
  if (triple.endsWith("unknown-linux-gnu")) return await buildLinuxPackages(built, opts);
  info(`no native Core installer for ${triple}; skipping`);
  return [];
}

/** Copy a produced installer under dist/<triple>/ and describe it. */
async function record(
  builtPath: string,
  triple: Triple,
  format: CoreInstallerAsset["format"],
): Promise<CoreInstallerAsset> {
  const filename = basename(builtPath);
  const relPath = `${triple}/${filename}`;
  await ensureDir(join(DIST_DIR, triple));
  const dest = join(DIST_DIR, relPath);
  await Deno.copyFile(builtPath, dest);
  const { sha256, size } = await sha256File(dest);
  ok(`  Core installer: ${filename}  ${humanBytes(size)}`);
  return { format, triple, filename, relPath, sha256, size };
}

// ---------------------------------------------------------------------------
// macOS .pkg (pkgbuild → productsign + notarytool when APPLE_* is set)

async function buildMacPkg(
  built: CoreBuildArtifacts,
  opts: CoreInstallerOpts,
): Promise<CoreInstallerAsset[]> {
  if (!(await have("pkgbuild"))) {
    info(colors.yellow(`pkgbuild not available; skipping Core .pkg for ${opts.triple}`));
    return [];
  }
  const { version, channel, triple, env } = opts;
  const suffix = channelBinSuffix(channel);
  const identifier = `${IDENTIFIER_BASE}${suffix}`;
  const work = await Deno.makeTempDir({ prefix: "tomat-core-pkg-" });
  const pkgRoot = join(work, "root");
  const scripts = join(work, "scripts");
  await ensureDir(scripts);
  // Install the payload under a neutral system prefix; the postinstall copies it
  // into the console user's ~/.tomat/<channel>/core and runs install-service.
  const installPrefix = `/usr/local/lib/tomat${suffix || "-stable"}`;
  const { binName } = await assemblePayload(built, triple, channel, pkgRoot);

  await Deno.writeTextFile(
    join(scripts, "postinstall"),
    macPostinstall(channel, installPrefix, binName),
  );
  await Deno.chmod(join(scripts, "postinstall"), 0o755);

  const unsigned = join(work, `tomat-core${suffix}-${version}.pkg`);
  await run([
    "pkgbuild",
    "--root",
    pkgRoot,
    "--identifier",
    identifier,
    "--version",
    version,
    "--scripts",
    scripts,
    "--install-location",
    installPrefix,
    unsigned,
  ]);

  let finalPkg = unsigned;
  if (env.appleSigningIdentity) {
    finalPkg = join(work, `tomat-core${suffix}-${version}-signed.pkg`);
    await run(["productsign", "--sign", env.appleSigningIdentity, unsigned, finalPkg]);
    await notarizePkg(finalPkg, env);
  } else {
    info(colors.yellow(`APPLE_SIGNING_IDENTITY unset; shipping an unsigned Core .pkg`));
  }
  // Name the published artifact stably (drop the -signed suffix).
  const published = join(work, `tomat-core${suffix}-${version}.pkg`);
  if (finalPkg !== published) await Deno.rename(finalPkg, published);
  return [await record(published, triple, "pkg")];
}

/** Notarize + staple a signed .pkg when notarization creds exist; otherwise warn
 *  (Gatekeeper will still block a signed-but-unnotarized pkg on download). */
async function notarizePkg(pkg: string, env: DeployEnv): Promise<void> {
  const args = ["notarytool", "submit", pkg, "--wait"];
  if (env.appleApiKey && env.appleApiIssuer && env.appleApiKeyPath) {
    args.push(
      "--key",
      env.appleApiKeyPath,
      "--key-id",
      env.appleApiKey,
      "--issuer",
      env.appleApiIssuer,
    );
  } else if (env.appleId && env.applePassword && env.appleTeamId) {
    args.push(
      "--apple-id",
      env.appleId,
      "--password",
      env.applePassword,
      "--team-id",
      env.appleTeamId,
    );
  } else {
    info(colors.yellow(`no notarization credentials; signed but NOT notarized`));
    return;
  }
  await run(["xcrun", ...args]);
  await run(["xcrun", "stapler", "staple", pkg]);
}

function macPostinstall(channel: ReleaseChannel, installPrefix: string, binName: string): string {
  // Runs as root. Resolve the console user, copy the payload into their home,
  // chown it, and register the (user-domain) service as that user.
  return `#!/bin/bash
set -euo pipefail
CONSOLE_USER="$(stat -f%Su /dev/console)"
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "root" ]; then
  echo "no console user; skipping per-user service registration" >&2
  exit 0
fi
USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory | awk '{print $2}')"
DEST="$USER_HOME/.tomat/${channel}/core"
mkdir -p "$DEST/bin" "$DEST/workers"
cp -R "${installPrefix}/bin/." "$DEST/bin/"
cp -R "${installPrefix}/workers/." "$DEST/workers/"
chown -R "$CONSOLE_USER" "$USER_HOME/.tomat/${channel}"
# Run install-service AS the console user with HOME pinned to their home: sudo's
# env_reset would otherwise leave HOME as root's, so the LaunchAgent plist +
# admin token would land in /var/root instead of the user home. The env prefix
# guarantees the var reaches the child regardless of the sudoers setenv policy.
sudo -u "$CONSOLE_USER" env HOME="$USER_HOME" TOMAT_CHANNEL="${channel}" "$DEST/bin/${binName}" install-service || true
exit 0
`;
}

// ---------------------------------------------------------------------------
// Windows NSIS .exe (makensis → signtool when a cert is configured)

async function buildWindowsNsis(
  built: CoreBuildArtifacts,
  opts: CoreInstallerOpts,
): Promise<CoreInstallerAsset[]> {
  if (!(await have("makensis"))) {
    info(colors.yellow(`makensis not available; skipping Core NSIS installer for ${opts.triple}`));
    return [];
  }
  const { version, channel, triple, env } = opts;
  const suffix = channelBinSuffix(channel);
  const work = await Deno.makeTempDir({ prefix: "tomat-core-nsis-" });
  const payload = join(work, "payload");
  const { binName } = await assemblePayload(built, triple, channel, payload);

  const nsi = join(work, "tomat-core.nsi");
  const outFile = join(work, `tomat-core${suffix}-setup-${version}.exe`);
  await Deno.writeTextFile(nsi, windowsNsi(channel, version, payload, binName, outFile));
  await run(["makensis", nsi]);

  if (env.windowsCertificateThumbprint || env.windowsSignCommand) {
    await signWindows(outFile, env);
  } else {
    info(colors.yellow(`no Windows cert; shipping an unsigned Core installer`));
  }
  return [await record(outFile, triple, "exe")];
}

async function signWindows(file: string, env: DeployEnv): Promise<void> {
  if (env.windowsSignCommand) {
    // A user-provided sign command with %1 replaced by the file (Tauri's convention).
    const argv = env.windowsSignCommand.replace(/%1/g, file).split(/\s+/);
    await run(argv);
    return;
  }
  await run([
    "signtool",
    "sign",
    "/sha1",
    env.windowsCertificateThumbprint,
    "/fd",
    "sha256",
    "/tr",
    env.windowsTimestampUrl,
    "/td",
    "sha256",
    file,
  ]);
}

function windowsNsi(
  channel: ReleaseChannel,
  version: string,
  payloadDir: string,
  binName: string,
  outFile: string,
): string {
  const suffix = channel === "stable" ? "" : `-${channel}`;
  // Per-user install (no admin): drop the payload into %USERPROFILE%\.tomat\<ch>\
  // core and run the subcommands. A native uninstaller (Add/Remove Programs) runs
  // uninstall-service.
  return `!include "MUI2.nsh"
Name "tomat Core${suffix}"
OutFile "${outFile}"
RequestExecutionLevel user
InstallDir "$PROFILE\\.tomat\\${channel}\\core"
!define UNINST_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\tomat-core${suffix}"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR\\bin"
  File /r "${join(payloadDir, "bin")}\\*"
  SetOutPath "$INSTDIR\\workers"
  File /r "${join(payloadDir, "workers")}\\*"
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  WriteRegStr HKCU "\${UNINST_KEY}" "DisplayName" "tomat Core${suffix}"
  WriteRegStr HKCU "\${UNINST_KEY}" "DisplayVersion" "${version}"
  WriteRegStr HKCU "\${UNINST_KEY}" "UninstallString" '"$INSTDIR\\uninstall.exe"'
  WriteRegStr HKCU "\${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\\uninstall.exe" /S'
  ; Register the background service via the binary's own subcommand.
  nsExec::Exec 'cmd.exe /c set TOMAT_CHANNEL=${channel}&& "$INSTDIR\\bin\\${binName}" install-service'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'cmd.exe /c set TOMAT_CHANNEL=${channel}&& "$INSTDIR\\bin\\${binName}" uninstall-service'
  DeleteRegKey HKCU "\${UNINST_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
`;
}

// ---------------------------------------------------------------------------
// Linux .deb + .rpm (dpkg-deb / rpmbuild)

async function buildLinuxPackages(
  built: CoreBuildArtifacts,
  opts: CoreInstallerOpts,
): Promise<CoreInstallerAsset[]> {
  const assets: CoreInstallerAsset[] = [];
  const deb = await buildDeb(built, opts).catch((e) => {
    info(colors.yellow(`Core .deb build skipped: ${e instanceof Error ? e.message : e}`));
    return null;
  });
  if (deb) assets.push(deb);
  const rpm = await buildRpm(built, opts).catch((e) => {
    info(colors.yellow(`Core .rpm build skipped: ${e instanceof Error ? e.message : e}`));
    return null;
  });
  if (rpm) assets.push(rpm);
  return assets;
}

function debArch(triple: Triple): string {
  return triple.startsWith("aarch64") ? "arm64" : "amd64";
}
function rpmArch(triple: Triple): string {
  return triple.startsWith("aarch64") ? "aarch64" : "x86_64";
}

async function buildDeb(
  built: CoreBuildArtifacts,
  opts: CoreInstallerOpts,
): Promise<CoreInstallerAsset> {
  if (!(await have("dpkg-deb"))) throw new Error("dpkg-deb not available");
  const { version, channel, triple } = opts;
  const suffix = channelBinSuffix(channel);
  const pkgName = `tomat-core${suffix}`;
  const work = await Deno.makeTempDir({ prefix: "tomat-core-deb-" });
  const debRoot = join(work, pkgName);
  const prefix = `/usr/lib/${pkgName}`;
  const { binName } = await assemblePayload(built, triple, channel, join(debRoot, prefix.slice(1)));

  const debian = join(debRoot, "DEBIAN");
  await ensureDir(debian);
  await Deno.writeTextFile(
    join(debian, "control"),
    `Package: ${pkgName}\nVersion: ${version}\nArchitecture: ${debArch(triple)}\n` +
      `Maintainer: tomat <noreply@au.tomat.ing>\nSection: utils\nPriority: optional\n` +
      `Description: tomat Core - the local-first AI client service\n`,
  );
  const postinst = join(debian, "postinst");
  const prerm = join(debian, "prerm");
  await Deno.writeTextFile(postinst, linuxPostinst(channel, prefix, binName));
  await Deno.writeTextFile(prerm, linuxPrerm(channel, prefix, binName));
  await Deno.chmod(postinst, 0o755);
  await Deno.chmod(prerm, 0o755);

  const outFile = join(work, `${pkgName}_${version}_${debArch(triple)}.deb`);
  await run(["dpkg-deb", "--root-owner-group", "--build", debRoot, outFile]);
  return await record(outFile, triple, "deb");
}

async function buildRpm(
  built: CoreBuildArtifacts,
  opts: CoreInstallerOpts,
): Promise<CoreInstallerAsset> {
  if (!(await have("rpmbuild"))) throw new Error("rpmbuild not available");
  const { version, channel, triple } = opts;
  const suffix = channelBinSuffix(channel);
  const pkgName = `tomat-core${suffix}`;
  const work = await Deno.makeTempDir({ prefix: "tomat-core-rpm-" });
  const prefix = `/usr/lib/${pkgName}`;
  const buildroot = join(work, "buildroot");
  const { binName } = await assemblePayload(
    built,
    triple,
    channel,
    join(buildroot, prefix.slice(1)),
  );

  // The deno-compiled core embeds its whole payload as a ~0.5 GB `.note.sui` ELF
  // note. rpm classifies every packaged file through libmagic, whose note-size cap
  // rejects that note ("Note section size too big"), failing the build; no spec
  // macro disables that classification. dpkg-deb has no such step, so only rpm
  // needs this: ship the core binary gzip-compressed (libmagic sees gzip data, not
  // the ELF) and decompress it in %post. The small helper ELFs classify fine, so
  // they stay raw. -n keeps the archive reproducible (no name/mtime in the header).
  await run(["gzip", "-n", join(buildroot, prefix.slice(1), "bin", binName)]);

  for (const d of ["SPECS", "RPMS", "BUILD", "BUILDROOT"]) await ensureDir(join(work, d));
  const spec = join(work, "SPECS", `${pkgName}.spec`);
  await Deno.writeTextFile(
    spec,
    // Disable rpm's default post-install processing: brp-strip runs `strip` over
    // the payload (harmless on the raw helper ELFs, but pointless), and
    // debug_package nil suppresses the debuginfo subpackage. The core binary is
    // shipped gzipped (see above) so brp never touches it either way.
    `%global __os_install_post %{nil}\n%global debug_package %{nil}\n\n` +
      `Name: ${pkgName}\nVersion: ${version}\nRelease: 1\nSummary: tomat Core service\n` +
      `License: proprietary\nBuildArch: ${rpmArch(triple)}\n\n` +
      `%description\ntomat Core - the local-first AI client service.\n\n` +
      `%files\n${prefix}\n\n` +
      `%post\n${linuxPostBody(channel, prefix, binName, { gunzipCore: true })}\n\n` +
      `%preun\n${linuxPreunBody(channel, prefix, binName)}\n`,
  );
  await run([
    "rpmbuild",
    "-bb",
    "--define",
    `_topdir ${work}`,
    "--define",
    `_rpmdir ${work}/RPMS`,
    "--buildroot",
    buildroot,
    spec,
  ]);
  // rpmbuild writes RPMS/<arch>/<name>-<ver>-1.<arch>.rpm.
  const rpmDir = join(work, "RPMS", rpmArch(triple));
  let outFile = "";
  for await (const e of Deno.readDir(rpmDir)) {
    if (e.name.endsWith(".rpm")) outFile = join(rpmDir, e.name);
  }
  if (!outFile) throw new Error("rpmbuild produced no .rpm");
  return await record(outFile, triple, "rpm");
}

// The install/removal bodies are shared between the deb maintainer scripts and
// the rpm scriptlets. They resolve the invoking user (packages install as root),
// copy the payload into that user's ~/.tomat/<channel>/core, and run the
// binary's own service subcommands as that user.
function linuxPostBody(
  channel: ReleaseChannel,
  prefix: string,
  binName: string,
  opts: { gunzipCore?: boolean } = {},
): string {
  // rpm ships the core binary gzipped (its ELF note breaks rpm's file classifier -
  // see buildRpm); decompress the copy in the user's home so install-service finds
  // the runnable binary. deb ships it raw and skips this.
  const gunzip = opts.gunzipCore ? `\n  gunzip -f "$DEST/bin/${binName}.gz"` : "";
  return `TARGET_USER="\${SUDO_USER:-$(logname 2>/dev/null || true)}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  echo "no target user; skipping per-user service registration" >&2
else
  USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  DEST="$USER_HOME/.tomat/${channel}/core"
  mkdir -p "$DEST/bin" "$DEST/workers"
  cp -R "${prefix}/bin/." "$DEST/bin/"${gunzip}
  cp -R "${prefix}/workers/." "$DEST/workers/"
  chown -R "$TARGET_USER" "$USER_HOME/.tomat/${channel}"
  su - "$TARGET_USER" -c "TOMAT_CHANNEL=${channel} '$DEST/bin/${binName}' install-service" || true
fi`;
}
function linuxPreunBody(channel: ReleaseChannel, _prefix: string, binName: string): string {
  return `TARGET_USER="\${SUDO_USER:-$(logname 2>/dev/null || true)}"
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
  USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  DEST="$USER_HOME/.tomat/${channel}/core"
  su - "$TARGET_USER" -c "TOMAT_CHANNEL=${channel} '$DEST/bin/${binName}' uninstall-service" || true
fi`;
}
function linuxPostinst(channel: ReleaseChannel, prefix: string, binName: string): string {
  return `#!/bin/sh\nset -e\n${linuxPostBody(channel, prefix, binName)}\nexit 0\n`;
}
function linuxPrerm(channel: ReleaseChannel, prefix: string, binName: string): string {
  return `#!/bin/sh\nset -e\n${linuxPreunBody(channel, prefix, binName)}\nexit 0\n`;
}

// ---------------------------------------------------------------------------
// publish: upload the installers + a signed core-installers.json manifest

interface CoreInstallersManifest {
  version: string;
  installers: Array<{
    format: CoreInstallerAsset["format"];
    triple: Triple;
    filename: string;
    url: string;
    sha256: string;
    size: number;
  }>;
}

/** Upload every built Core installer to R2 and publish a signed
 *  core-installers.json (Ed25519, same trust root as core.json) the website's
 *  download CTA reads. Carries forward same-version entries from the live
 *  manifest a single-runner publish didn't rebuild. Returns the installer
 *  binaries as GitHub-Release assets ({ path, flat name }) so the caller can
 *  mirror them to the rolling release exactly like client bundles/APKs; the
 *  core-installers.json + .sig it writes under dist/<manifestDir> are picked up
 *  by the publisher's manifest walk automatically. */
export async function uploadCoreInstallers(
  env: DeployEnv,
  channel: ReleaseChannel,
  version: string,
  installers: CoreInstallerAsset[],
  opts: ApplyOpts,
): Promise<Array<{ path: string; name: string }>> {
  if (installers.length === 0) return [];
  const manifestDir = channelManifestDir(channel);
  const storagePrefix = channelStoragePrefix(channel);
  const live = await fetchLiveJson<CoreInstallersManifest>(
    env,
    `${manifestDir}/core-installers.json`,
  );

  step(`Composing core-installers.json (${installers.length} installer(s))`);
  // Keep same-version entries this run did not rebuild (keyed by triple+filename).
  const byKey = new Map<string, CoreInstallersManifest["installers"][number]>();
  if (live?.version === version) {
    for (const e of live.installers) byKey.set(`${e.triple}/${e.filename}`, e);
  }
  const uploads: Array<{
    key: string;
    path: string;
    label: string;
    size: number;
    aliasKey: string;
  }> = [];
  for (const a of installers) {
    const path = await reanchorFile(a.relPath, a.sha256);
    const key = `${storagePrefix}${version}/${a.triple}/${a.filename}`;
    byKey.set(`${a.triple}/${a.filename}`, {
      format: a.format,
      triple: a.triple,
      filename: a.filename,
      url: `https://${env.storageDomain}/${key}`,
      sha256: a.sha256,
      size: a.size,
    });
    uploads.push({
      key,
      path,
      label: `${a.triple}_${a.filename}`,
      size: a.size,
      // Version-less alias so the website links a stable download URL without
      // knowing the version (mirrors android.ts's current/ APK alias).
      aliasKey: `${storagePrefix}current/${a.triple}/${coreInstallerStableName(a.format, channel)}`,
    });
  }

  const manifest: CoreInstallersManifest = { version, installers: [...byKey.values()] };

  const outDir = join(DIST_DIR, manifestDir);
  await ensureDir(outDir);
  const manifestPath = join(outDir, "core-installers.json");
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
  ok(`core-installers.json → ${rel(manifestPath)}`);

  // Detached Ed25519 signature over the exact manifest bytes (same trust root +
  // shape as client.json.sig), so a consumer can authenticate it before trusting
  // any URL/sha256 it lists.
  const sig = await signEd25519Bytes(env.signingPrivateKey, await Deno.readFile(manifestPath));
  const sigPath = join(outDir, "core-installers.json.sig");
  await Deno.writeTextFile(sigPath, sig);

  if (opts.dryRun) {
    info(colors.yellow(`dry-run: skipping upload of ${uploads.length} installer(s) + manifest`));
    return [];
  }
  step(`Uploading Core installer(s) to R2 bucket "${env.r2Bucket}"`);
  const ghAssets: Array<{ path: string; name: string }> = [];
  for (const u of uploads) {
    info(`uploading ${u.key}  (${humanBytes(u.size)})`);
    await r2Put(env, u.key, u.path, "application/octet-stream");
    opts.recordVersionedKey?.(u.key);
    // Mirror to the version-less current/ alias the website links against. Short
    // cache (via the same header the manifests use); the versioned copy above is
    // the source of truth the signed core-installers.json names.
    info(`uploading ${u.aliasKey}  (alias)`);
    await r2Put(env, u.aliasKey, u.path, "application/octet-stream", "public, max-age=300");
    // u.label is already the per-triple-unique flat name (`<triple>_<filename>`),
    // which is exactly what the GitHub-Release mirror needs to avoid basename
    // clobbering across triples.
    ghAssets.push({ path: u.path, name: u.label });
  }
  await r2Put(
    env,
    `${manifestDir}/core-installers.json`,
    manifestPath,
    "application/json",
    "public, max-age=300",
  );
  await r2Put(
    env,
    `${manifestDir}/core-installers.json.sig`,
    sigPath,
    "text/plain",
    "public, max-age=300",
  );
  ok(`https://${env.storageDomain}/${manifestDir}/core-installers.json`);
  return ghAssets;
}
