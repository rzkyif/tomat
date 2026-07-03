// Install-command logic, shared by the no-JS baseline (InstallGenerator.astro)
// and the enhanced island (InstallGenerator.svelte) so the two never drift. The
// command set mirrors the published installers under get.au.tomat.ing/install:
// env vars sit on the `sh`/`bash` side of the pipe (so the script, not curl,
// sees them) and as `$env:` lines on Windows PowerShell.

export const STORAGE_BASE = "https://get.au.tomat.ing";

export type Target = "client" | "core";
export type Os = "macos" | "linux" | "windows" | "android";
export type Channel = "stable" | "latest";

export interface CoreOptions {
  /** Listen on the network (TOMAT_INSTALL_BIND_ALL) so other machines pair. */
  bindAll: boolean;
  /** Run as a background service at login (TOMAT_INSTALL_SERVICE). */
  service: boolean;
}

export interface ClientUninstallOptions {
  /** Also wipe saved settings and paired cores (--purge / TOMAT_PURGE). */
  purge: boolean;
}

export interface CoreUninstallOptions {
  /** Keep the Core's sessions and memories instead of removing them
   *  (--keep-data / TOMAT_KEEP_DATA). */
  keepData: boolean;
}

export interface OsChoice {
  id: Os;
  label: string;
  icon: string;
}

// Client runs everywhere; the core has no Android build.
export const CLIENT_OS: OsChoice[] = [
  { id: "macos", label: "macOS", icon: "i-mdi-apple" },
  { id: "linux", label: "Linux", icon: "i-mdi-linux" },
  { id: "windows", label: "Windows", icon: "i-mdi-microsoft-windows" },
  { id: "android", label: "Android", icon: "i-mdi-android" },
];
export const CORE_OS: OsChoice[] = CLIENT_OS.slice(0, 3);

export function osChoices(target: Target): OsChoice[] {
  return target === "client" ? CLIENT_OS : CORE_OS;
}

// Stable is the installer's default (no env var); latest opts in via
// TOMAT_CHANNEL. The order matches the installer: channel, then bind, then
// service.
function envVars(channel: Channel, core?: CoreOptions): Array<[string, string]> {
  const vars: Array<[string, string]> = [];
  if (channel !== "stable") vars.push(["TOMAT_CHANNEL", channel]);
  if (core?.bindAll) vars.push(["TOMAT_INSTALL_BIND_ALL", "1"]);
  if (core && !core.service) vars.push(["TOMAT_INSTALL_SERVICE", "0"]);
  return vars;
}

// Env vars ride on the runner's side of the pipe (so the script sees them);
// `flags` are positional args the script's own arg parser reads, passed through
// the piped runner as `<runner> -s -- <flag...>` (the uninstall scripts take
// --purge / --keep-data this way, since they read flags, not env vars).
function shCommand(
  script: string,
  runner: "sh" | "bash",
  vars: Array<[string, string]>,
  flags: string[] = [],
): string {
  const env = vars.map(([k, v]) => `${k}=${v} `).join("");
  const tail = flags.length ? ` -s -- ${flags.join(" ")}` : "";
  return `curl -fsSL ${STORAGE_BASE}/install/${script} | ${env}${runner}${tail}`;
}

function psCommand(script: string, vars: Array<[string, string]>): string {
  const prefix = vars.map(([k, v]) => `$env:${k}="${v}"; `).join("");
  return `${prefix}irm ${STORAGE_BASE}/install/${script} | iex`;
}

/** The one-liner for installing the client. Android has no shell installer
 *  (it is a sideloaded APK, see {@link androidApkUrl}), so it returns "". */
export function clientCommand(os: Os, channel: Channel): string {
  if (os === "android") return "";
  const vars = envVars(channel);
  if (os === "windows") return psCommand("client.ps1", vars);
  return shCommand("client.sh", "sh", vars);
}

/** The one-liner for installing the core, with its options folded in. */
export function coreCommand(os: Os, channel: Channel, opts: CoreOptions): string {
  const vars = envVars(channel, opts);
  if (os === "windows") return psCommand("core.ps1", vars);
  return shCommand("core.sh", "bash", vars);
}

/** The one-liner for removing the client, with its purge option folded in.
 *  Mirrors {@link clientCommand}: the channel rides as an env var, and Android
 *  has no script (it is removed like any app, see {@link androidApkUrl}), so it
 *  returns "". Purge passes through as the `--purge` flag on bash and the
 *  `TOMAT_PURGE` env var on Windows (a switch can't cross `irm | iex`). */
export function clientUninstallCommand(
  os: Os,
  channel: Channel,
  opts: ClientUninstallOptions,
): string {
  if (os === "android") return "";
  const vars = envVars(channel);
  if (os === "windows") {
    if (opts.purge) vars.push(["TOMAT_PURGE", "1"]);
    return psCommand("client-uninstall.ps1", vars);
  }
  return shCommand("client-uninstall.sh", "bash", vars, opts.purge ? ["--purge"] : []);
}

/** The one-liner for removing the core, with its keep-data option folded in.
 *  Mirrors {@link coreUninstallCommand}'s client twin: keep-data passes through
 *  as the `--keep-data` flag on bash and the `TOMAT_KEEP_DATA` env var on
 *  Windows. */
export function coreUninstallCommand(os: Os, channel: Channel, opts: CoreUninstallOptions): string {
  const vars = envVars(channel);
  if (os === "windows") {
    if (opts.keepData) vars.push(["TOMAT_KEEP_DATA", "1"]);
    return psCommand("core-uninstall.ps1", vars);
  }
  return shCommand("core-uninstall.sh", "bash", vars, opts.keepData ? ["--keep-data"] : []);
}

// ---------------------------------------------------------------------------
// Native installer downloads (the primary CTA)
//
// The conventional double-click installers - macOS `.dmg`/`.pkg`, Windows
// `.exe`, Linux `.deb`/`.rpm` - published by scripts/release/{client,core-
// installers}.ts. Each release also mirrors every installer to a version-less
// `current/<triple>/<stable-name>` R2 key (exactly like {@link androidApkUrl}),
// so this page links a stable URL without knowing the version. The stable names
// here are kept in sync with coreInstallerStableName() / clientBundleAlias() on
// the release side.

export type Arch = "arm64" | "x64";
export type InstallerFormat = "dmg" | "pkg" | "exe" | "deb" | "rpm";

export interface NativeInstaller {
  os: Os;
  arch: Arch;
  format: InstallerFormat;
  /** The direct download URL (the version-less `current/` alias). */
  url: string;
  /** Human arch label for the button, e.g. "Apple Silicon" / "Intel". */
  archLabel: string;
}

// [arch, target triple, human arch label] per desktop OS. Order is the one the
// page offers the buttons in (the most common arch first).
const OS_TRIPLES: Record<Exclude<Os, "android">, Array<[Arch, string, string]>> = {
  macos: [
    ["arm64", "aarch64-apple-darwin", "Apple Silicon"],
    ["x64", "x86_64-apple-darwin", "Intel"],
  ],
  linux: [
    ["x64", "x86_64-unknown-linux-gnu", "x86-64"],
    ["arm64", "aarch64-unknown-linux-gnu", "ARM64"],
  ],
  windows: [
    ["x64", "x86_64-pc-windows-msvc", "x86-64"],
    ["arm64", "aarch64-pc-windows-msvc", "ARM64"],
  ],
};

// Channel binary suffix, matching channelBinSuffix() on the release side: stable
// is bare, other channels append `-<channel>`.
function binSuffix(channel: Channel): string {
  return channel === "stable" ? "" : `-${channel}`;
}

function currentUrl(channel: Channel, triple: string, filename: string): string {
  const prefix = channel === "stable" ? "" : `${channel}/`;
  return `${STORAGE_BASE}/${prefix}current/${triple}/${filename}`;
}

// The installer formats a given target offers per OS. macOS/Windows are a single
// double-click file; Linux offers both the Debian and RPM package.
function formatsFor(target: Target, os: Exclude<Os, "android">): InstallerFormat[] {
  if (os === "macos") return target === "core" ? ["pkg"] : ["dmg"];
  if (os === "windows") return ["exe"];
  return ["deb", "rpm"];
}

// The version-less stable filename for one installer, matching the release-side
// alias names (coreInstallerStableName / clientBundleAlias / the dmg/deb/rpm
// aliases in client.ts).
function stableName(target: Target, format: InstallerFormat, channel: Channel): string {
  const base = target === "core" ? "tomat-core" : "tomat";
  const suffix = binSuffix(channel);
  if (format === "exe") return `${base}${suffix}-setup.exe`;
  return `${base}${suffix}.${format}`;
}

/** Native double-click installers for a target on an OS, one entry per
 *  arch x format. Android has no installer here (it is a sideloaded APK, see
 *  {@link androidApkUrl}), so it returns []. */
export function nativeInstallers(target: Target, os: Os, channel: Channel): NativeInstaller[] {
  if (os === "android") return [];
  const out: NativeInstaller[] = [];
  for (const [arch, triple, archLabel] of OS_TRIPLES[os]) {
    for (const format of formatsFor(target, os)) {
      out.push({
        os,
        arch,
        format,
        archLabel,
        url: currentUrl(channel, triple, stableName(target, format, channel)),
      });
    }
  }
  return out;
}

/** The "how to" steps for a native installer download, shared by both generator
 *  variants (like {@link commandStepsTail} for the command path). Generic across
 *  OS: the double-click flow is the same everywhere. */
export function nativeInstallSteps(target: Target): string[] {
  if (target === "core") {
    return [
      "Open the downloaded installer and follow the prompts.",
      "It installs Core and starts it in the background at login.",
      "Open a tomat Client on any device and pair it to this Core.",
    ];
  }
  return [
    "Open the downloaded installer and follow the prompts.",
    "Launch tomat when it finishes.",
    "Pick where its Core should run, on this computer or another you have.",
  ];
}

/** A one-line note about the OS security prompt an UNSIGNED installer triggers,
 *  or null when the platform's installer is signed. Windows installers ship
 *  unsigned for now (SmartScreen warns); macOS + the rest are signed. */
export function unsignedInstallerNote(os: Os): string | null {
  if (os === "windows") {
    return "Windows may warn that the publisher is unknown. Choose More info, then Run anyway.";
  }
  return null;
}

/** Short, user-facing label for an installer format, for the download button. */
export function formatLabel(format: InstallerFormat): string {
  switch (format) {
    case "dmg":
      return "Disk image (.dmg)";
    case "pkg":
      return "Installer (.pkg)";
    case "exe":
      return "Installer (.exe)";
    case "deb":
      return "Debian (.deb)";
    case "rpm":
      return "Red Hat (.rpm)";
  }
}

/** The fixed "newest build" APK alias published per channel by
 *  scripts/release/android.ts, so the page can link a stable URL without
 *  knowing the version. The `current` segment is the moving alias; the channel
 *  prefix namespaces it (stable has none, latest is `latest/`). */
export function androidApkUrl(channel: Channel): string {
  const prefix = channel === "stable" ? "" : `${channel}/`;
  return `${STORAGE_BASE}/${prefix}current/android-universal/tomat.apk`;
}

/** The OS-specific first "how to" step: which terminal to open. Split out from
 *  the rest so the no-JS baseline can CSS-toggle it per OS while rendering the
 *  fixed tail (see {@link commandStepsTail}) statically, and the island can read
 *  it reactively. */
export function openTerminalStep(os: Os): string {
  return os === "windows"
    ? "Open PowerShell."
    : os === "macos"
      ? "Open Terminal."
      : "Open your terminal.";
}

/** The "how to" steps after the OS-specific opener ({@link openTerminalStep}),
 *  fixed per mode + target. The install-only "uninstallation guide" pointer is
 *  appended by the caller, since it carries a link rather than plain text. */
export function commandStepsTail(mode: "install" | "uninstall", target: Target): string[] {
  const run = "Paste the command above and press Enter.";
  if (mode === "uninstall") {
    return [
      run,
      target === "core"
        ? "It stops the Core and removes it; use the option above to keep its sessions and memories."
        : "It removes the app but keeps your settings; use the option above to wipe them too.",
    ];
  }
  if (target === "core") {
    return [
      run,
      "Set an admin password when prompted; you'll need it to pair more devices.",
      "When it finishes, note the pairing code it prints.",
    ];
  }
  return [run, "When it finishes, launch tomat and pick where its Core should run."];
}

/** Map a navigator string to one of our OS ids, best-effort. */
export function detectOs(ua: string, platform: string): Os {
  const s = `${ua} ${platform}`.toLowerCase();
  if (s.includes("android")) return "android";
  if (s.includes("win")) return "windows";
  if (s.includes("linux")) return "linux";
  // mac, iphone, ipad all map to the macOS installer here.
  if (s.includes("mac") || s.includes("iphone") || s.includes("ipad")) {
    return "macos";
  }
  return "macos";
}
