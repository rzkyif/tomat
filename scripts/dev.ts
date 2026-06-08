// Boots tomat-core (deno watch) and tomat-client (tauri dev) together on the
// "dev" install channel, so all state lives under ~/.tomat/dev/ and never
// touches a stable install. Seeds a dev admin token (the from-source core
// never mints one; only the installer does) and prints a ready-to-use
// pairing code so connecting the client is a one-paste step.
// Stops both children on SIGINT/SIGTERM or when either exits.

import { join } from "@std/path";
import { ensureDir } from "@std/fs/ensure-dir";
import { BUILTIN_TOOLKIT_ID } from "@tomat/shared";
import { hashToolkit } from "../packages/tomat-core/src/toolkits/hash.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// Dev runs on the "dev" install channel (~/.tomat/dev/{core,client}). Both
// children inherit TOMAT_CHANNEL so core and the Tauri client agree on the
// isolated location + keychain namespace.
const CHANNEL_ENV = { TOMAT_CHANNEL: "dev" };
// The dev core binds the dev-channel port (stable base 7800 + dev offset 20,
// see packages/tomat-core/src/paths.ts) and serves the API over TLS with a
// self-signed cert. The dev task trusts that cert for loopback via
// --unsafely-ignore-certificate-errors=127.0.0.1 (set in deno.json), so these
// HTTPS calls to the local core succeed without a public CA.
const CORE_URL = "https://127.0.0.1:7820";

function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error("could not determine home directory (no HOME or USERPROFILE)");
  }
  return home;
}

const DEV_CORE_DIR = join(homeDir(), ".tomat", "dev", "core");
const ADMIN_TOKEN_FILE = join(DEV_CORE_DIR, ".admin-token");

// Dev built-in toolkit manifest. There is no published manifests/dev/toolkit.json,
// so dev.ts generates one from the in-repo toolkit (and regenerates it on edits)
// at the cache path core reads. The version carries a content hash so any edit to
// the codebase toolkit reads as "Update available" after a check; "Update" then
// reinstalls the codebase copy. Keep the version formula in sync with
// computeDevManifest() in packages/tomat-core/src/toolkits/builtin-manifest.ts.
const BUILTIN_SRC_DIR = join(ROOT, "packages", "tomat-builtin-toolkit");
const DEV_TOOLKIT_MANIFEST = join(DEV_CORE_DIR, "cache", "builtin-toolkit-manifest.json");

async function writeDevToolkitManifest(): Promise<void> {
  let pkgVersion = "0.0.0";
  try {
    const cfg = JSON.parse(await Deno.readTextFile(join(BUILTIN_SRC_DIR, "deno.json"))) as {
      version?: string;
    };
    pkgVersion = cfg.version ?? "0.0.0";
  } catch {
    // fall through with the default version
  }
  const contentHash = await hashToolkit(BUILTIN_SRC_DIR);
  const manifest = {
    schemaVersion: 1,
    version: `${pkgVersion}+dev.${contentHash.slice(0, 8)}`,
    id: BUILTIN_TOOLKIT_ID,
    tarballUrl: "",
    sha256: "",
    signature: "",
  };
  await ensureDir(join(DEV_CORE_DIR, "cache"));
  const tmp = DEV_TOOLKIT_MANIFEST + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(manifest, null, 2));
  await Deno.rename(tmp, DEV_TOOLKIT_MANIFEST);
}

/** Regenerate the dev manifest now, then on every change under the codebase
 *  toolkit (debounced). Fire-and-forget: the watcher lives for the dev session
 *  and is torn down when the orchestrator exits. */
async function startDevToolkitManifest(): Promise<void> {
  await writeDevToolkitManifest();
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      for await (const _event of Deno.watchFs(BUILTIN_SRC_DIR)) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void writeDevToolkitManifest().catch(() => {}), 200);
      }
    } catch {
      // watch failures are non-fatal in dev
    }
  })();
}
// The dev client persists its paired-cores list here; deleting it sends the
// next boot back through core management (see the boot gate in
// packages/tomat-client/src/ui/routes/+page.svelte).
const CLIENT_SETTINGS_FILE = join(homeDir(), ".tomat", "dev", "client", "settings.json");

// CLI flags, wired to the deno tasks in deno.json:
//  --reset          delete the dev client's settings.json before launch so the
//                   client boots into core management instead of straight to
//                   chat (dev:reset / dev:reset:install).
//  --fresh-install  make "On this computer" show the fresh-install confirm
//                   screen. Sets TOMAT_DEV_FRESH_INSTALL for the client (read
//                   by the Tauri pairing commands) and skips the remote prefill
//                   so that flow is front-and-center (dev:reset:install).
const RESET = Deno.args.includes("--reset");
const FRESH_INSTALL = Deno.args.includes("--fresh-install");

// All child labels ("core", "client", "dev") are left-aligned to this width so
// the message columns line up regardless of label length.
const LABEL_WIDTH = 6;

// Color only when stdout is a real terminal and NO_COLOR is unset, so piping the
// dev output to a file (or NO_COLOR=1) yields clean, escape-free text.
const useColor = !Deno.env.get("NO_COLOR") && Deno.stdout.isTerminal();

function color(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

// Compact wall-clock HH:MM:SS.mmm. dev.ts is the single timestamp authority for
// the multiplexed console: children emit bare messages (core skips its own
// timestamp via TOMAT_LOG_NO_TIME) and this stamp is prepended to every line.
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
    d.getMilliseconds(),
    3,
  )}`;
}

// `<time> <badge> ` prefix, built per line at write time so the timestamp marks
// when the line arrived. The badge color is the child's SGR code.
function linePrefix(name: string, code: string): string {
  return `${color("2", stamp())} ${color(code, name.padEnd(LABEL_WIDTH))} `;
}

// Strip ANSI escape sequences so the line matchers see plain text (tauri runs
// cargo with `--color always`, and Deno bolds its "Watcher" prefix). Matches the
// full CSI family, not just SGR color (`m`): cargo prefixes its final "Finished"
// status with a clear-line `\x1b[2K`, so an `m`-only strip would leave a leading
// ESC and miss the match.
// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Our own logs (core's @std/log + the client's fern) start every line with a
// lowercase, padded level word. That positive signal is how we recognize a line
// as ours and pass it through untouched; anything else is build noise (dropped)
// or a leak (wrapped, below).
const LEVEL_RE = /^(?:error|warn|info|debug|trace)\s/;

// The tauri-cli / cargo / deno-task orchestration chatter that shares the child's
// stream with the app's own logs. Pure noise, dropped outright. Build
// ERRORS/warnings don't match these, so they fall through to the leak path and
// still surface (clearly marked as not-ours).
const BUILD_NOISE = [
  /^Running BeforeDevCommand\b/,
  /^Running DevCommand\b/,
  /^Running `/,
  /^Compiling\b/,
  /^Finished\b/,
  /^Building\b/,
  /^Blocking\b/,
  /^Updating\b/,
  /^Locking\b/,
  /^Info\b/, // tauri-cli "Info Watching ... for changes..." (our logs are lowercase)
  /^Task\b/, // deno "Task dev:vite deno run ..."
];

// Level SGR codes, matching core's @std/log + the client's fern coloring (see
// each package's log module): debug dim, info green, warn yellow, error red.
const LEVEL_CODE = { debug: "2", info: "32", warn: "33", error: "31" } as const;

// Render a line dev.ts synthesizes itself in the same `<level> <scope> <message>`
// shape the children's own logs use, so it groups with them visually. The level
// word is padded to 5 like @std/log / fern; the scope is dim.
function levelLine(level: keyof typeof LEVEL_CODE, scope: string, message: string): string {
  return `${color(LEVEL_CODE[level], level.padEnd(5))} ${color("2", scope)} ${message}`;
}

// Wrap a line that did NOT come from our logging system in a dim "leak" marker
// so it's obvious it bypassed our format. We rely on a denylist for build noise,
// so new leaks are inevitable; marking (not hiding) them keeps them visible.
function leakLine(content: string): string {
  return `${color("2", "leak".padEnd(5))} ${content}`;
}

// Decide how a raw child line is presented: pass our own logs through verbatim,
// drop build noise, render the known watcher lines as standard leveled logs, and
// wrap everything else as a leak. Returns null to drop.
function formatChildLine(raw: string): string | null {
  const plain = raw.replace(ANSI_RE, "").trimStart();
  if (plain.trim() === "") return null; // blank spacing from build tools
  if (BUILD_NOISE.some((re) => re.test(plain))) return null;
  if (LEVEL_RE.test(plain)) return raw; // our log: keep it (and its colors) verbatim
  // Deno's `--watch` supervisor emits a small, known family of lines on core's
  // stream: "Restarting! File change detected: ..." (only on an actual reload),
  // "Waiting for graceful termination..." (on every reload and on Ctrl-C), and
  // "Process started/finished.". They're fully expected, so render them as
  // standard leveled `watcher`-scoped logs instead of leaks: the reload event as
  // info, the rest as debug chatter.
  const watcher = plain.match(/^Watcher\s+(.*)$/);
  if (watcher) {
    const body = watcher[1];
    const level = body.startsWith("Restarting!") ? "info" : "debug";
    return levelLine(level, "watcher", body);
  }
  return leakLine(plain);
}

type Child = {
  name: string;
  proc: Deno.ChildProcess;
};

const children: Child[] = [];

function spawn(
  name: string,
  code: string,
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>,
): Child {
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: cwd ?? ROOT,
    // Merge atop the parent env so PATH / HOME / etc. carry through.
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).spawn();

  void pipe(proc.stdout, stdoutWriter, name, code);
  void pipe(proc.stderr, stderrWriter, name, code);

  void proc.status.then((status) => {
    console.log(`${linePrefix(name, code)}exited with code ${status.code}`);
    void shutdown();
  });

  return { name, proc };
}

// A WritableStream permits only one active writer, so every child's stdout/
// stderr pipe shares one long-lived writer per std stream. Acquiring a second
// writer on Deno.stdout/stderr (e.g. once per child) throws "The stream is
// already locked". The writers are never released; they live for the whole
// dev session.
const stdoutWriter = Deno.stdout.writable.getWriter();
const stderrWriter = Deno.stderr.writable.getWriter();

async function pipe(
  source: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  name: string,
  code: string,
): Promise<void> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // Collapse a line to the content after its last carriage return: progress
  // redraws (cargo's "\r    Finished …") would otherwise survive and let the
  // terminal overwrite our badge. The settled tail is what a TTY would show.
  const settle = (s: string) => (s.includes("\r") ? s.slice(s.lastIndexOf("\r") + 1) : s);
  let buf = "";
  try {
    for await (const chunk of source) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const out = formatChildLine(settle(line));
        if (out === null) continue;
        await writer.write(encoder.encode(`${linePrefix(name, code)}${out}\n`));
      }
    }
    if (buf.length > 0) {
      const out = formatChildLine(settle(buf));
      if (out !== null) {
        await writer.write(encoder.encode(`${linePrefix(name, code)}${out}\n`));
      }
    }
  } catch {
    // Stream ended; ignore.
  }
}

function devLog(msg: string): void {
  console.log(`${linePrefix("dev", "33")}${msg}`);
}

// Generate (once) and return the dev core's admin token. The from-source core
// never writes ~/.tomat/dev/core/.admin-token itself, so without this the
// client could not mint a pairing code against it. Written only when absent,
// so an existing pairing keeps working across dev restarts.
async function ensureAdminToken(): Promise<string> {
  await Deno.mkdir(DEV_CORE_DIR, { recursive: true });
  try {
    const existing = (await Deno.readTextFile(ADMIN_TOKEN_FILE)).trim();
    if (existing) return existing;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await Deno.writeTextFile(ADMIN_TOKEN_FILE, token);
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(ADMIN_TOKEN_FILE, 0o600);
    } catch {
      /* best-effort */
    }
  }
  return token;
}

// Wait for the dev core to answer, mint a pairing code, print how to connect,
// and return the code (or null on failure). Runs before the client spawns so
// the code can be forwarded as a launch argument that prefills onboarding.
// Best-effort: on any failure, print the manual command and return null.
async function mintPairingCode(token: string): Promise<string | null> {
  let up = false;
  for (let i = 0; i < 60; i++) {
    if (shuttingDown) return null;
    try {
      const r = await fetch(`${CORE_URL}/api/v1/health`);
      await r.body?.cancel();
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* core not bound yet */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  // -k: the dev core's TLS cert is self-signed (see CORE_URL), so curl needs
  // --insecure to reach it when run by hand.
  const manual = `  curl -sk -X POST -H "X-Admin-Token: ${token}" ${CORE_URL}/api/v1/pairing/codes`;
  if (!up) {
    devLog("core did not come up in time; mint a pairing code manually:");
    devLog(manual);
    return null;
  }
  try {
    const r = await fetch(`${CORE_URL}/api/v1/pairing/codes`, {
      method: "POST",
      headers: { "X-Admin-Token": token, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { code?: string };
    if (!data.code) throw new Error("response had no code");
    const bar = "─".repeat(58);
    devLog(bar);
    if (FRESH_INSTALL) {
      devLog(`Fresh-install test: "On this computer" shows the install screen.`);
      devLog(`Or pair via "On another computer" with:`);
    } else {
      devLog(`Onboarding fields are prefilled into the launched client.`);
      devLog(`Either option will connect to this dev core:`);
    }
    devLog(`  URL : ${CORE_URL}`);
    devLog(`  Code: ${data.code}`);
    devLog(bar);
    return data.code;
  } catch (err) {
    devLog(
      `could not mint a pairing code (${err instanceof Error ? err.message : err}); mint manually:`,
    );
    devLog(manual);
    return null;
  }
}

// Delete the dev client's settings.json so the next boot lands on core
// management instead of going straight to chat. Best-effort: an absent file is
// already "reset".
async function resetClientSettings(): Promise<void> {
  try {
    await Deno.remove(CLIENT_SETTINGS_FILE);
    devLog(`--reset: deleted ${CLIENT_SETTINGS_FILE}`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      devLog("--reset: no client settings to delete (already clean)");
      return;
    }
    devLog(`--reset: could not delete client settings: ${err}`);
  }
}

// Collect a pid plus every descendant (children, grandchildren, …), gathered
// up front before any are killed: once a parent dies its children reparent to
// init and can no longer be found via `pgrep -P`. Deno's proc.kill() signals
// only the direct child, so without walking the tree the Tauri CLI's vite dev
// server (port 1420) and the built app binary survive as orphans that block the
// next `deno task dev` run. Unix-only; on Windows just returns the pid itself.
async function processTree(pid: number): Promise<number[]> {
  if (Deno.build.os === "windows") return [pid];
  const tree = [pid];
  try {
    const out = await new Deno.Command("pgrep", {
      args: ["-P", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    const kids = new TextDecoder()
      .decode(out.stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    for (const kid of kids) tree.push(...(await processTree(kid)));
  } catch {
    // pgrep unavailable; fall back to just this pid.
  }
  return tree;
}

// pids holding a TCP listen socket on `port` (Unix-only; empty if lsof is
// missing). Used to reclaim port 1420 from a stale vite server orphaned by a
// previous dev session that didn't shut down cleanly.
async function listenersOn(port: number): Promise<number[]> {
  if (Deno.build.os === "windows") return [];
  try {
    const out = await new Deno.Command("lsof", {
      args: ["-ti", `tcp:${port}`, "-sTCP:LISTEN"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder()
      .decode(out.stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

const VITE_PORT = 1420;

// Free the Vite dev port before starting the client, in case an earlier dev
// session left an orphan behind (e.g. killed with SIGKILL, bypassing shutdown).
async function reclaimVitePort(): Promise<void> {
  for (const pid of await listenersOn(VITE_PORT)) {
    devLog(`port ${VITE_PORT} held by stale pid ${pid}; terminating it`);
    try {
      Deno.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const VITE_CACHE_DIRS = [
  join(ROOT, "packages", "tomat-client", ".vite"),
  join(ROOT, "packages", "tomat-client", "node_modules", ".vite"),
];

// A `deps_temp_*` dir inside a Vite cache marks a dependency optimization that
// was interrupted (Vite hard-killed mid-flight). Left in place it crashes the
// next startup deep in rolldown ("Failed to unwrap exclusive reference of
// `BindingBundler`"). A healthy cache holds only a `deps` dir, so we wipe the
// cache only when that corruption marker is present, never slowing a clean
// start. Vite re-optimizes from scratch on the next run (~0.5 s).
async function clearStaleViteCache(): Promise<void> {
  for (const dir of VITE_CACHE_DIRS) {
    let interrupted = false;
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory && entry.name.startsWith("deps_temp_")) {
          interrupted = true;
          break;
        }
      }
    } catch {
      continue; // cache dir absent
    }
    if (interrupted) {
      devLog(`clearing interrupted Vite cache at ${dir}`);
      try {
        await Deno.remove(dir, { recursive: true });
      } catch (err) {
        devLog(`could not clear ${dir}: ${err}`);
      }
    }
  }
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Gather every child's full descendant tree first, then signal them all, so
  // tauri's vite server + app binary die with the session instead of leaking.
  const pids = new Set<number>();
  for (const { proc } of children) {
    for (const pid of await processTree(proc.pid)) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }
  // Anything still alive after a 3 s grace period gets SIGKILL, then exit.
  setTimeout(() => {
    for (const pid of pids) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
    Deno.exit(0);
  }, 3000);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, shutdown);
  } catch {
    // SIGTERM unsupported on Windows; ignore.
  }
}

const adminToken = await ensureAdminToken();

// Generate the dev built-in toolkit manifest before core boots so first-boot
// seeding can resolve a version, and keep it fresh as the codebase toolkit is
// edited.
await startDevToolkitManifest();

children.push(
  spawn(
    "core",
    "36",
    ["deno", "run", "--watch", "--allow-all", "packages/tomat-core/src/main.ts"],
    undefined,
    // Worker .ts files live in the source tree during dev so edits hot-
    // reload via --watch. Without this override, paths().workersDir would
    // point at ~/.tomat/dev/core/workers (an empty dir in dev).
    {
      ...CHANNEL_ENV,
      TOMAT_WORKERS_DIR: `${ROOT}packages/tomat-core/src/workers`,
      // Core runs under `deno run --watch`. On a file change the watcher sends
      // SIGTERM and waits for the program to wind down so it can re-run the
      // module in-process. This flag tells core's SIGTERM handler to skip its
      // Deno.exit(0) (which would hard-kill the watcher and end the dev session)
      // and instead let the event loop drain for the restart. See main.ts.
      TOMAT_DEV_WATCH: "1",
      // dev.ts owns the timestamp + badge column, so core emits bare console
      // lines (no ISO timestamp). Its stderr is piped here (not a TTY), so force
      // color on so level coloring survives.
      TOMAT_LOG_NO_TIME: "1",
      ...(useColor ? { TOMAT_LOG_COLOR: "1" } : {}),
    },
  ),
);

await reclaimVitePort();
await clearStaleViteCache();

// Mint the pairing code before spawning the client so it can be forwarded as a
// launch argument. The core boots in parallel during the health poll inside.
const pairingCode = await mintPairingCode(adminToken);

// --reset: clear the client's paired-cores state so it boots into onboarding.
if (RESET) await resetClientSettings();

// Replicate the client package's one-line `dev` task (deno.json) so we can
// forward arguments to the Tauri app binary. `tauri dev` treats args after the
// first `--` as runner (cargo) args and args after a SECOND `--` as app args,
// so the prefill flags go after `-- --` to reach the binary's argv (read by the
// read_launch_prefill command). Skipped under --fresh-install, where the
// chooser should stay on "On this computer".
const clientCmd = ["deno", "run", "-A", "npm:@tauri-apps/cli@^2", "dev"];
if (!FRESH_INSTALL) {
  const prefill = [`--core-url=${CORE_URL}`];
  if (pairingCode) prefill.push(`--pairing-code=${pairingCode}`);
  clientCmd.push("--", "--", ...prefill);
}

// The core may have exited during the health poll (which triggers shutdown);
// don't spawn the client into a tearing-down session.
if (!shuttingDown) {
  // The Tauri CLI builds vite + cargo before the app binary runs and emits its
  // first "tomat client starting" line, and that build chatter is filtered out
  // here. Emit a synthetic client line up front (mirroring the client's fern
  // format) so the console shows the client is building; it stays the latest
  // client message until the binary starts (or a build error leaks through
  // pipe()). Written directly like devLog, so it bypasses formatChildLine.
  console.log(`${linePrefix("client", "35")}${levelLine("info", "boot", "tomat client building")}`);
  children.push(
    spawn("client", "35", clientCmd, `${ROOT}packages/tomat-client`, {
      ...CHANNEL_ENV,
      // dev.ts owns the timestamp + badge column and the client's stdout is
      // piped here (not a TTY), so the client emits bare lines and forces color
      // on, exactly like the core spawn above.
      TOMAT_LOG_NO_TIME: "1",
      ...(useColor ? { TOMAT_LOG_COLOR: "1" } : {}),
      ...(FRESH_INSTALL ? { TOMAT_DEV_FRESH_INSTALL: "1" } : {}),
    }),
  );
}

await Promise.all(children.map((c) => c.proc.status));
