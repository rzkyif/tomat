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

function shCommand(script: string, runner: "sh" | "bash", vars: Array<[string, string]>): string {
  const env = vars.map(([k, v]) => `${k}=${v} `).join("");
  return `curl -fsSL ${STORAGE_BASE}/install/${script} | ${env}${runner}`;
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

/** The one-liner for removing the client. Mirrors {@link clientCommand}: the
 *  channel rides as an env var, and Android has no script (it is removed like
 *  any app, see {@link androidApkUrl}), so it returns "". The wipe-everything
 *  flag (`--purge` / `-Purge`) is documented separately, not folded in here. */
export function clientUninstallCommand(os: Os, channel: Channel): string {
  if (os === "android") return "";
  const vars = envVars(channel);
  if (os === "windows") return psCommand("client-uninstall.ps1", vars);
  return shCommand("client-uninstall.sh", "bash", vars);
}

/** The one-liner for removing the core. Mirrors {@link coreCommand} without the
 *  install options; the keep-data flag (`--keep-data` / `-KeepData`) is
 *  documented separately rather than folded in. */
export function coreUninstallCommand(os: Os, channel: Channel): string {
  const vars = envVars(channel);
  if (os === "windows") return psCommand("core-uninstall.ps1", vars);
  return shCommand("core-uninstall.sh", "bash", vars);
}

/** The fixed "newest build" APK alias published per channel by
 *  scripts/release/android.ts, so the page can link a stable URL without
 *  knowing the version. The `current` segment is the moving alias; the channel
 *  prefix namespaces it (stable has none, latest is `latest/`). */
export function androidApkUrl(channel: Channel): string {
  const prefix = channel === "stable" ? "" : `${channel}/`;
  return `${STORAGE_BASE}/${prefix}current/android-universal/tomat.apk`;
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
