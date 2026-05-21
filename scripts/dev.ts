// Boots tomat-core (deno watch) and tomat-client (tauri dev) together.
// Stops both children on SIGINT/SIGTERM or when either exits.

const ROOT = new URL("..", import.meta.url).pathname;

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
    // point at ~/.tomat/core/workers (an empty dir in dev).
    { TOMAT_WORKERS_DIR: `${ROOT}packages/tomat-core/src/workers` },
  ),
);

children.push(
  spawn("client", "35", [
    "deno",
    "task",
    "dev",
  ], `${ROOT}packages/tomat-client`),
);

await Promise.all(children.map((c) => c.proc.status));
