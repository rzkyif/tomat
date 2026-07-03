// OS background-service registration + teardown for tomat-core.
//
// This is the source of truth the install scripts used to duplicate: it writes
// the launchd LaunchAgent (macOS), the systemd user unit (Linux), or the
// Task Scheduler task (Windows) that starts core at login and restarts it on
// failure, all namespaced per channel so stable / latest / dev coexist. The
// TOMAT_CHANNEL is baked into the service environment so the daemon resolves the
// same ~/.tomat/<channel>/core subtree. TOMAT_INSTALL_SERVICE=0 skips the
// service and just launches core in the background (client owns liveness).
//
// uninstall-service reverses it: stop + remove the service, kill stragglers,
// delete the keychain master key, and remove the channel's core dir - always
// preserving the shared ~/.tomat/models weights.

import { dirname, join } from "@std/path";
import { channel, channelKeychainSuffix, channelSuffix, coreRoot, paths } from "../paths.ts";
import { binPath } from "../paths.ts";
import { coreBinaryName } from "../binaries/versions.ts";
import { keychainDelete } from "../services/keychain.ts";
import { progress } from "./io.ts";
import { realHome, run, runPwsh } from "./proc.ts";

function installedBinary(): string {
  return binPath(coreBinaryName("tomat-core"));
}

function serviceLabel(): string {
  return `au.tomat.core${channelSuffix()}`;
}

function systemdUnitName(): string {
  return `tomat-core${channelSuffix()}`;
}

/** Register (and start) the OS service, or launch in the background when
 *  TOMAT_INSTALL_SERVICE=0. Assumes the core binary is already on disk (placed
 *  by the seed step / native installer / self-install). */
export async function installService(): Promise<void> {
  const asService = (Deno.env.get("TOMAT_INSTALL_SERVICE") ?? "1") !== "0";
  await Deno.mkdir(paths().logsDir, { recursive: true });

  if (!asService) {
    await startBackground();
    return;
  }
  switch (Deno.build.os) {
    case "darwin":
      await installLaunchd();
      return;
    case "linux":
      await installSystemd();
      return;
    case "windows":
      await installScheduledTask();
      return;
    default:
      throw new Error(`unsupported OS for service install: ${Deno.build.os}`);
  }
}

/** Stop + remove the service, kill stragglers, clear the keychain master key,
 *  and remove the channel's core dir (unless keepData). */
export async function uninstallService(opts: { keepData: boolean }): Promise<void> {
  switch (Deno.build.os) {
    case "darwin":
      await removeLaunchd();
      break;
    case "linux":
      await removeSystemd();
      break;
    case "windows":
      await removeScheduledTask();
      break;
    default:
      throw new Error(`unsupported OS for service uninstall: ${Deno.build.os}`);
  }
  await killStragglers();
  if (!opts.keepData) {
    await clearKeychainMasterKey();
    await removeCoreDir();
  } else {
    progress("keeping core data and keychain master key (--keep-data)");
  }
}

// --- macOS launchd --------------------------------------------------------

function plistPath(): string {
  return join(realHome(), "Library", "LaunchAgents", `${serviceLabel()}.plist`);
}

async function installLaunchd(): Promise<void> {
  const bin = installedBinary();
  const logs = paths().logsDir;
  const plist = plistPath();
  await Deno.mkdir(dirname(plist), { recursive: true });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>${serviceLabel()}</string>
  <key>ProgramArguments</key><array><string>${bin}</string></array>
  <key>EnvironmentVariables</key><dict><key>TOMAT_CHANNEL</key><string>${channel()}</string></dict>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>${join(logs, "core.stdout.log")}</string>
  <key>StandardErrorPath</key><string>${join(logs, "core.stderr.log")}</string>
</dict>
</plist>
`;
  await Deno.writeTextFile(plist, xml);
  await run(["launchctl", "unload", plist], { ignoreError: true });
  const rc = await run(["launchctl", "load", plist]);
  if (!rc.success) {
    throw new Error(`launchctl load failed (exit ${rc.code}); inspect ${plist}`);
  }
  progress(`registered launchd agent ${serviceLabel()}`);
}

async function removeLaunchd(): Promise<void> {
  const plist = plistPath();
  if (!(await fileExists(plist))) {
    progress("launchd agent not installed");
    return;
  }
  // `launchctl unload` is non-zero for benign reasons (already exited); the
  // load-bearing step is removing the plist so it isn't auto-loaded next login.
  await run(["launchctl", "unload", plist], { ignoreError: true });
  await Deno.remove(plist).catch(() => {});
  progress(`removed launchd agent ${serviceLabel()}`);
}

// --- Linux systemd (user) -------------------------------------------------

function systemdUnitPath(): string {
  return join(realHome(), ".config", "systemd", "user", `${systemdUnitName()}.service`);
}

async function haveSystemdUser(): Promise<boolean> {
  return (await run(["systemctl", "--user", "--version"], { ignoreError: true })).success;
}

async function installSystemd(): Promise<void> {
  if (!(await haveSystemdUser())) {
    progress("systemd --user unavailable; starting core in the background instead");
    await startBackground();
    return;
  }
  const bin = installedBinary();
  const logs = paths().logsDir;
  const unit = systemdUnitPath();
  await Deno.mkdir(dirname(unit), { recursive: true });
  const contents = `[Unit]
Description=${systemdUnitName()}
Wants=network-online.target
After=network-online.target

[Service]
Environment=TOMAT_CHANNEL=${channel()}
ExecStart=${bin}
Restart=on-failure
RestartSec=5
StandardOutput=append:${join(logs, "core.stdout.log")}
StandardError=append:${join(logs, "core.stderr.log")}

[Install]
WantedBy=default.target
`;
  await Deno.writeTextFile(unit, contents);
  const reload = await run(["systemctl", "--user", "daemon-reload"]);
  if (!reload.success) {
    throw new Error("systemctl --user daemon-reload failed; re-run with TOMAT_INSTALL_SERVICE=0");
  }
  const enable = await run([
    "systemctl",
    "--user",
    "enable",
    "--now",
    `${systemdUnitName()}.service`,
  ]);
  if (!enable.success) {
    throw new Error("systemctl --user enable failed; re-run with TOMAT_INSTALL_SERVICE=0");
  }
  progress(`enabled systemd user unit ${systemdUnitName()}`);
}

async function removeSystemd(): Promise<void> {
  const unit = systemdUnitPath();
  if (!(await fileExists(unit))) {
    progress("systemd user unit not installed");
    return;
  }
  await run(["systemctl", "--user", "disable", "--now", `${systemdUnitName()}.service`], {
    ignoreError: true,
  });
  await Deno.remove(unit).catch(() => {});
  await run(["systemctl", "--user", "daemon-reload"], { ignoreError: true });
  progress(`removed systemd user unit ${systemdUnitName()}`);
}

// --- Windows Task Scheduler -----------------------------------------------

async function installScheduledTask(): Promise<void> {
  const bin = installedBinary();
  const task = systemdUnitName(); // same tomat-core<suffix> naming
  const ch = channel();
  // Scheduled tasks have no environment field, so for non-stable channels wrap
  // the launch in cmd.exe to set TOMAT_CHANNEL before exec (mirrors core.ps1).
  const action =
    ch === "stable"
      ? `$a = New-ScheduledTaskAction -Execute '${bin}'`
      : `$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c set TOMAT_CHANNEL=${ch}&& "${bin}"'`;
  const script = `
${action}
$t = New-ScheduledTaskTrigger -AtLogOn
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${task}' -Action $a -Trigger $t -Settings $s -Principal $p -Description 'tomat-core' | Out-Null
Start-ScheduledTask -TaskName '${task}'
`;
  const rc = await runPwsh(script);
  if (!rc.success) {
    throw new Error(
      "Register-ScheduledTask failed; Task Scheduler may be disabled. Re-run with TOMAT_INSTALL_SERVICE=0",
    );
  }
  progress(`registered scheduled task ${task}`);
}

async function removeScheduledTask(): Promise<void> {
  const task = systemdUnitName();
  await runPwsh(
    `Stop-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue; ` +
      `Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false -ErrorAction SilentlyContinue`,
    { ignoreError: true },
  );
  progress(`removed scheduled task ${task}`);
}

// --- TOMAT_INSTALL_SERVICE=0 background launch ----------------------------

async function startBackground(): Promise<void> {
  const bin = installedBinary();
  const logs = paths().logsDir;
  const out = join(logs, "core.stdout.log");
  const err = join(logs, "core.stderr.log");
  if (Deno.build.os === "windows") {
    await runPwsh(
      `$env:TOMAT_CHANNEL='${channel()}'; ` +
        `Start-Process -FilePath '${bin}' -WindowStyle Hidden ` +
        `-RedirectStandardOutput '${out}' -RedirectStandardError '${err}'`,
    );
  } else {
    // Detach via sh so the `&`-backgrounded core outlives this short-lived CLI,
    // exactly like the scripts' nohup branch.
    const shell = `nohup ${shQuote(bin)} >> ${shQuote(out)} 2>> ${shQuote(err)} &`;
    new Deno.Command("sh", {
      args: ["-c", shell],
      env: { ...Deno.env.toObject(), TOMAT_CHANNEL: channel() },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  }
  progress("started core in the background (no service registered)");
}

// --- shared teardown steps ------------------------------------------------

async function killStragglers(): Promise<void> {
  const binName = coreBinaryName("tomat-core");
  if (Deno.build.os === "windows") {
    await runPwsh(
      `Get-Process -Name '${binName.replace(/\.exe$/, "")}' -ErrorAction SilentlyContinue | ` +
        `Stop-Process -Force -ErrorAction SilentlyContinue`,
      { ignoreError: true },
    );
    return;
  }
  const target = join(paths().binDir, binName);
  const found = await run(["pgrep", "-f", target], { ignoreError: true });
  if (!found.success) return;
  const pids = found.stdout
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pid of pids) await run(["kill", pid], { ignoreError: true });
  // Brief grace, then SIGKILL any survivors.
  await new Promise((r) => setTimeout(r, 1000));
  for (const pid of pids) await run(["kill", "-9", pid], { ignoreError: true });
  if (pids.length) progress(`stopped ${pids.length} straggler core process(es)`);
}

async function clearKeychainMasterKey(): Promise<void> {
  const service = `au.tomat.core${channelKeychainSuffix()}`;
  // keychainDelete is idempotent and returns false when the helper is absent;
  // on macOS fall back to the native security tool so a partially-removed
  // install still clears the entry.
  const ok = await keychainDelete(service, "master-key");
  if (ok) {
    progress("cleared keychain master key");
    return;
  }
  if (Deno.build.os === "darwin") {
    await run(["security", "delete-generic-password", "-s", service, "-a", "master-key"], {
      ignoreError: true,
    });
    progress("cleared keychain master key (security fallback)");
  }
}

async function removeCoreDir(): Promise<void> {
  const root = coreRoot();
  if (!(await fileExists(root))) {
    progress("core directory already gone");
    return;
  }
  try {
    await Deno.remove(root, { recursive: true });
  } catch (err) {
    // On Windows this subcommand IS the running tomat-core.exe under
    // <root>/bin, so it can't delete its own on-disk image (sharing violation).
    // Remove everything we can now and leave the locked binary for the caller
    // that outlives this process (the NSIS uninstaller's RMDir, or the thin
    // core-uninstall.ps1's post-exit retry) to sweep. On unix a running binary's
    // file deletes fine, so this branch is Windows-only in practice.
    if (Deno.build.os !== "windows") throw err;
    const self = Deno.execPath();
    await removeExcept(root, self);
    progress(`removed core data; the running binary is swept after exit`);
    return;
  }
  // Drop the now-empty ~/.tomat/<channel> dir if the client is gone too; the
  // shared models dir lives under ~/.tomat, not the channel dir, so it survives.
  await Deno.remove(dirname(root)).catch(() => {});
  progress(`removed ${root}`);
}

// Recursively delete everything under `dir` except the single file at `keep`
// (the currently-running executable, which Windows keeps locked). Best-effort
// per entry so one locked file never aborts the rest of the teardown.
async function removeExcept(dir: string, keep: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (path === keep) continue;
    if (entry.isDirectory) {
      await removeExcept(path, keep);
      await Deno.remove(path).catch(() => {}); // now-empty (or still holds `keep`)
    } else {
      await Deno.remove(path).catch(() => {});
    }
  }
}

// --- small utilities ------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// Single-quote a path for a POSIX shell (only the nohup branch needs this).
function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
