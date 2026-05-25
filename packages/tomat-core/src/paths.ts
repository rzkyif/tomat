// Canonical filesystem layout for tomat-core.
// All paths derived from a single root (~/.tomat/core/ by default).
// Override the root via TOMAT_CORE_HOME env for testing.

import { join } from "@std/path";

function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "could not determine home directory (no HOME or USERPROFILE)",
    );
  }
  return home;
}

export function coreRoot(): string {
  const override = Deno.env.get("TOMAT_CORE_HOME");
  if (override) return override;
  return join(homeDir(), ".tomat", "core");
}

export function clientRoot(): string {
  return join(homeDir(), ".tomat", "client");
}

export interface CorePaths {
  root: string;
  configFile: string;
  settingsFile: string;
  secretsEncFile: string;
  secretsPlainFile: string;
  adminTokenFile: string;
  dbFile: string;
  binDir: string;
  binLibDir: string;
  denoCacheDir: string;
  stagingDir: string;
  sessionsDir: string;
  modelsDir: string;
  toolkitsDir: string;
  workersDir: string;
  cacheDir: string;
  logsDir: string;
  logFile: string;
  // Written by self-updater before the binary swap; consumed by main.ts on
  // startup to detect post-update first boot vs. crash-loop after a failed
  // update (→ rollback). See update/rollback.ts.
  updateMarkerFile: string;
}

export function paths(): CorePaths {
  const root = coreRoot();
  const bin = join(root, "bin");
  const cache = join(root, "cache");
  const logs = join(root, "logs");
  // Worker .ts files are shipped separately from the compiled binary and
  // installed under ~/.tomat/core/workers/. Computing this path here
  // (instead of `new URL("../workers/...", import.meta.url)` at every
  // spawn site) keeps the worker files OUT of `deno compile`'s static
  // import graph — otherwise the workers' npm deps (~1.6 GB of ONNX +
  // transformers + kokoro) get baked into every core binary.
  //
  // Dev override: scripts/dev.ts sets TOMAT_WORKERS_DIR to the in-repo
  // source path so editing a worker .ts has immediate effect.
  const workersDir = Deno.env.get("TOMAT_WORKERS_DIR") ??
    join(root, "workers");
  return {
    root,
    configFile: join(root, "core.json"),
    settingsFile: join(root, "settings.json"),
    secretsEncFile: join(root, "secrets.enc"),
    secretsPlainFile: join(root, "secrets.json"),
    adminTokenFile: join(root, ".admin-token"),
    dbFile: join(root, "core.sqlite"),
    binDir: bin,
    binLibDir: join(bin, "lib"),
    denoCacheDir: join(root, "deno-cache"),
    stagingDir: join(root, "staging"),
    sessionsDir: join(root, "sessions"),
    modelsDir: join(root, "models"),
    toolkitsDir: join(root, "toolkits"),
    workersDir,
    cacheDir: cache,
    logsDir: logs,
    logFile: join(logs, "core.log"),
    updateMarkerFile: join(root, "update.pending.json"),
  };
}

// Subpath helpers used by routes / repos.

export function sessionDir(sessionId: string): string {
  return join(paths().sessionsDir, sessionId);
}

export function sessionAttachmentsDir(sessionId: string): string {
  return join(sessionDir(sessionId), "attachments");
}

export function toolkitDir(toolkitId: string): string {
  return join(paths().toolkitsDir, toolkitId);
}

export function modelPath(relPath: string): string {
  return join(paths().modelsDir, relPath);
}

export function binPath(name: string): string {
  return join(paths().binDir, name);
}

// Creates every long-lived directory eagerly. Called from main.ts at boot.
export async function ensureDirs(): Promise<void> {
  const p = paths();
  for (
    const dir of [
      p.root,
      p.binDir,
      p.binLibDir,
      p.denoCacheDir,
      p.stagingDir,
      p.sessionsDir,
      p.modelsDir,
      p.toolkitsDir,
      p.workersDir,
      p.cacheDir,
      p.logsDir,
    ]
  ) {
    await Deno.mkdir(dir, { recursive: true });
  }
}
