// Canonical filesystem layout for tomat-core.
// Per-channel state derives from a single channel root
// (~/.tomat/<channel>/core, default channel "stable"). The base dir
// (~/.tomat) is selected by TOMAT_CHANNEL so dev / beta installs isolate
// their state from a stable install. Models are the one exception: they
// live at the shared ~/.tomat/models so multi-GB weights aren't
// re-downloaded per channel. TOMAT_CORE_HOME overrides the core root
// outright (tests point it at a tempdir).

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

const CHANNELS = ["stable", "dev", "beta"] as const;

// The install channel, from TOMAT_CHANNEL (default "stable"). Selects the
// ~/.tomat/<channel>/ subtree for all per-channel state. Throws on an
// unknown value so a typo can't silently mis-isolate data.
export function channel(): string {
  const raw = (Deno.env.get("TOMAT_CHANNEL") ?? "stable").trim() || "stable";
  if (!(CHANNELS as readonly string[]).includes(raw)) {
    throw new Error(
      `invalid TOMAT_CHANNEL: ${raw} (expected one of ${CHANNELS.join(", ")})`,
    );
  }
  return raw;
}

// ~/.tomat — the channel-independent base, home of the shared models dir.
// A TOMAT_CORE_HOME override (tests) takes its place so models stay inside
// the isolated tempdir alongside the rest of the test state.
function tomatBase(): string {
  return Deno.env.get("TOMAT_CORE_HOME") ?? join(homeDir(), ".tomat");
}

// ~/.tomat/<channel> — the per-channel root holding core + client state.
function channelRoot(): string {
  return join(homeDir(), ".tomat", channel());
}

// Suffix that namespaces per-channel resources (binary filenames, keychain
// service names, OS service labels) away from stable. Stable → "" (bare
// name); dev/beta → "-dev" / "-beta". Mirrors the install scripts + channel.rs.
export function channelSuffix(): string {
  const ch = channel();
  return ch === "stable" ? "" : `-${ch}`;
}

// Back-compat alias: keychain services use the same suffix scheme.
export function channelKeychainSuffix(): string {
  return channelSuffix();
}

// On-disk filename for one of tomat's own binaries, namespaced per channel so
// a beta install's tomat-core-beta never collides with stable's tomat-core.
// The .exe suffix (Windows) is added by callers via platformExe(). Upstream
// sidecars (llama-server, …) keep their original names — they're isolated by
// the per-channel bin dir, and renaming third-party archives is pointless.
export function channelBinName(base: string): string {
  return `${base}${channelSuffix()}`;
}

// Default service ports, offset per channel so stable + beta cores (and their
// sidecars) can run simultaneously. Stable keeps the historical ports; dev /
// beta shift by a fixed offset. An explicit value in settings.json still wins;
// only the default moves. Bases: core 7800, llama 7701, whisper 7702.
const CHANNEL_PORT_OFFSET: Record<string, number> = {
  stable: 0,
  beta: 10,
  dev: 20,
};

function channelPortOffset(): number {
  return CHANNEL_PORT_OFFSET[channel()] ?? 0;
}

export function corePort(): number {
  return 7800 + channelPortOffset();
}

export function llmPort(): number {
  return 7701 + channelPortOffset();
}

export function sttPort(): number {
  return 7702 + channelPortOffset();
}

export function coreRoot(): string {
  const override = Deno.env.get("TOMAT_CORE_HOME");
  if (override) return override;
  return join(channelRoot(), "core");
}

export function clientRoot(): string {
  return join(channelRoot(), "client");
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
    // Shared across channels: ~/.tomat/models (not under the channel root),
    // so dev / beta reuse the same downloaded weights as stable.
    modelsDir: join(tomatBase(), "models"),
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
