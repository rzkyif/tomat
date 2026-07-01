// Runs shellcheck over every tracked shell script. The install/uninstall scripts
// under scripts/install/ are the current trust entry point (they download,
// verify Ed25519-signed manifests, and install the app), so a shell bug there is
// a security-relevant bug; oxlint never sees .sh, so nothing else guards them.
//
// Wired into `deno task lint` via scripts/lint-walkers.ts. Scans warning-level
// and above (`--severity=warning`) to focus on real problems over style nits on
// these large existing scripts; tighten to `style` later if desired.
//
// shellcheck is an external binary (`brew install shellcheck` /
// `apt install shellcheck`). When it is not installed this walker SKIPS with a
// visible warning and exits 0, so a contributor without it can still run
// `deno task lint`; CI installs shellcheck so the check is enforced there. Only
// findings (never a missing binary) fail the walker.
//
// PowerShell (.ps1) is not covered here (shellcheck can't parse it); a
// PSScriptAnalyzer pass is a possible future follow-up.

import { fromFileUrl } from "@std/path";

// Native OS path (fromFileUrl); URL .pathname is an invalid "/C:/..." cwd on Windows.
const ROOT = fromFileUrl(new URL("../../", import.meta.url));
const SEVERITY = "warning";

async function trackedShellScripts(): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z", "*.sh"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    console.error("check-shell-scripts: `git ls-files` failed.");
    console.error(new TextDecoder().decode(out.stderr));
    Deno.exit(2);
  }
  return new TextDecoder()
    .decode(out.stdout)
    .split("\0")
    .filter((p) => p.length > 0);
}

async function shellcheckAvailable(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("shellcheck", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false; // not on PATH
  }
}

const files = await trackedShellScripts();
if (files.length === 0) {
  console.log("check-shell-scripts: no tracked .sh files.");
  Deno.exit(0);
}

if (!(await shellcheckAvailable())) {
  console.warn(
    "check-shell-scripts: shellcheck not found on PATH; SKIPPING.\n" +
      "  Install it to lint the install scripts locally:\n" +
      "    macOS:  brew install shellcheck\n" +
      "    Debian: apt install shellcheck\n" +
      "  CI installs it, so this check is still enforced there.",
  );
  Deno.exit(0);
}

const { code, stdout, stderr } = await new Deno.Command("shellcheck", {
  args: [`--severity=${SEVERITY}`, "--format=gcc", "--", ...files],
  cwd: ROOT,
  stdout: "piped",
  stderr: "piped",
}).output();

const out = (new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr)).trimEnd();
if (code !== 0) {
  console.error(`shellcheck reported issues (severity >= ${SEVERITY}):\n`);
  if (out) console.error(out);
  console.error(
    "\nFix each finding, or annotate a justified exception inline with a\n" +
      "`# shellcheck disable=SCXXXX` directive above the line (with a reason).",
  );
  Deno.exit(1);
}
console.log(`check-shell-scripts: ${files.length} script(s) clean (severity >= ${SEVERITY}).`);
