// Boots tomat-core (deno watch) and tomat-client (tauri dev) together on the
// "dev" install channel, so all state lives under ~/.tomat/dev/ and never
// touches a stable install. Seeds a dev admin token (the from-source core
// never mints one — only the installer does) and prints a ready-to-use
// pairing code so connecting the client is a one-paste step.
// Stops both children on SIGINT/SIGTERM or when either exits.

import { join } from "jsr:@std/path@^1";

const ROOT = new URL("..", import.meta.url).pathname;

// Dev runs on the "dev" install channel (~/.tomat/dev/{core,client}). Both
// children inherit TOMAT_CHANNEL so core and the Tauri client agree on the
// isolated location + keychain namespace.
const CHANNEL_ENV = { TOMAT_CHANNEL: "dev" };
const CORE_URL = "http://127.0.0.1:7800";

function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "could not determine home directory (no HOME or USERPROFILE)",
    );
  }
  return home;
}

const DEV_CORE_DIR = join(homeDir(), ".tomat", "dev", "core");
const ADMIN_TOKEN_FILE = join(DEV_CORE_DIR, ".admin-token");

type Child = {
  name: string;
  proc: Deno.ChildProcess;
};

const children: Child[] = [];

function spawn(
  name: string,
  color: string,
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

  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
  void pipe(proc.stdout, Deno.stdout.writable, prefix);
  void pipe(proc.stderr, Deno.stderr.writable, prefix);

  void proc.status.then((status) => {
    console.log(`${prefix} exited with code ${status.code}`);
    shutdown();
  });

  return { name, proc };
}

async function pipe(
  source: ReadableStream<Uint8Array>,
  dest: WritableStream<Uint8Array>,
  prefix: string,
): Promise<void> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const writer = dest.getWriter();
  let buf = "";
  try {
    for await (const chunk of source) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        await writer.write(encoder.encode(`${prefix} ${line}\n`));
      }
    }
    if (buf.length > 0) {
      await writer.write(encoder.encode(`${prefix} ${buf}\n`));
    }
  } catch {
    // Stream ended; ignore.
  } finally {
    writer.releaseLock();
  }
}

function devLog(msg: string): void {
  console.log(`\x1b[33m[dev]\x1b[0m ${msg}`);
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
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  await Deno.writeTextFile(ADMIN_TOKEN_FILE, token);
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(ADMIN_TOKEN_FILE, 0o600);
    } catch { /* best-effort */ }
  }
  return token;
}

// Wait for the dev core to answer, mint a pairing code, and print how to
// connect the client. Best-effort: on any failure, print the manual command.
async function announcePairing(token: string): Promise<void> {
  let up = false;
  for (let i = 0; i < 60; i++) {
    if (shuttingDown) return;
    try {
      const r = await fetch(`${CORE_URL}/api/v1/health`);
      await r.body?.cancel();
      if (r.ok) {
        up = true;
        break;
      }
    } catch { /* core not bound yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  const manual =
    `  curl -s -X POST -H "X-Admin-Token: ${token}" ${CORE_URL}/api/v1/pairing/codes`;
  if (!up) {
    devLog("core did not come up in time; mint a pairing code manually:");
    devLog(manual);
    return;
  }
  try {
    const r = await fetch(`${CORE_URL}/api/v1/pairing/codes`, {
      method: "POST",
      headers: { "X-Admin-Token": token, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as { code?: string };
    if (!data.code) throw new Error("response had no code");
    const bar = "─".repeat(58);
    devLog(bar);
    devLog(`Pair the client → choose "On another computer":`);
    devLog(`  URL : ${CORE_URL}`);
    devLog(`  Code: ${data.code}   (only needed for the first pairing)`);
    devLog(`Do NOT click "On this computer" — it installs a production core.`);
    devLog(bar);
  } catch (err) {
    devLog(
      `could not mint a pairing code (${
        err instanceof Error ? err.message : err
      }); mint manually:`,
    );
    devLog(manual);
  }
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { name, proc } of children) {
    try {
      proc.kill("SIGTERM");
    } catch (err) {
      console.error(`failed to terminate ${name}:`, err);
    }
  }
  // Give children 3 s to wind down, then exit.
  setTimeout(() => Deno.exit(0), 3000);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, shutdown);
  } catch {
    // SIGTERM unsupported on Windows; ignore.
  }
}

const adminToken = await ensureAdminToken();

children.push(
  spawn(
    "core",
    "36",
    [
      "deno",
      "run",
      "--watch",
      "--allow-all",
      "packages/tomat-core/src/main.ts",
    ],
    undefined,
    // Worker .ts files live in the source tree during dev so edits hot-
    // reload via --watch. Without this override, paths().workersDir would
    // point at ~/.tomat/dev/core/workers (an empty dir in dev).
    {
      ...CHANNEL_ENV,
      TOMAT_WORKERS_DIR: `${ROOT}packages/tomat-core/src/workers`,
    },
  ),
);

children.push(
  spawn(
    "client",
    "35",
    [
      "deno",
      "task",
      "dev",
    ],
    `${ROOT}packages/tomat-client`,
    CHANNEL_ENV,
  ),
);

void announcePairing(adminToken);

await Promise.all(children.map((c) => c.proc.status));
