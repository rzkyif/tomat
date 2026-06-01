// Model + binary types shared across core and client.

// All triples the binary manifest publishes. Core only ever downloads the
// host triple's binary at install time.
export const TRIPLES = [
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;

export type Triple = (typeof TRIPLES)[number];

export const BINARY_KINDS = ["llama-server", "whisper-server", "deno"] as const;

export type BinaryKind = (typeof BINARY_KINDS)[number];

// HF-style spec: "@user/repo/branch/file". Branch may be "main".
// The model storage path is derived by stripping the leading "@" and treating
// the remainder as a relative path under ~/.tomat/core/models/.
export type ModelSpec = `@${string}/${string}/${string}/${string}`;

export interface ModelEntry {
  source: ModelSpec | string;
  relPath: string;
  absPath: string;
  sizeBytes: number;
}

export type DownloadStatus = "Pending" | "Downloading" | "Completed" | "Error" | "Cancelled";

// Wire shape served by /api/v1/models/downloads and broadcast over WS as
// `downloads.snapshot`.
export interface DownloadEntry {
  id: string;
  source: string;
  destination: "models" | "binaries" | "toolkits";
  relPath: string;
  absPath: string;
  filename: string;
  groupId: string;
  sizeBytes?: number;
  downloadedBytes: number;
  status: DownloadStatus;
  error?: string;
  addedAtMs: number;
}

export interface DownloadPlan {
  source: string;
  alreadyHave: boolean;
  sizeHint?: number;
  /** Resolved version for sidecar-binary plans (e.g. an upstream release tag).
   *  Unset for model files. */
  version?: string;
}

// A binary manifest entry is one of two shapes:
//
//  - Pinned (stable channel): exact per-triple URLs + sha256, resolved at
//    release time. The signed manifest commits to the exact bytes.
//  - Resolver (beta channel): an upstream GitHub repo + per-triple asset name
//    patterns. The core resolves the LATEST release at runtime, so upstream
//    updates reach beta users without us re-releasing. The signed manifest
//    commits to the repo + patterns (not the version); the download is
//    verified against GitHub's published sha256 digest.
export interface BinaryManifestPinnedEntry {
  version: string;
  platforms: Record<Triple, { url: string; sha256: string }>;
}

// `assets` maps a triple to the upstream asset name; "{tag}" expands to the
// release's tag_name (e.g. "llama-{tag}-bin-macos-arm64.tar.gz").
export interface UpstreamResolver {
  repo: string;
  assets: Partial<Record<Triple, string>>;
}

export interface BinaryManifestResolverEntry {
  resolver: UpstreamResolver;
}

export type BinaryManifestEntry = BinaryManifestPinnedEntry | BinaryManifestResolverEntry;

export function isResolverEntry(e: BinaryManifestEntry): e is BinaryManifestResolverEntry {
  return (e as BinaryManifestResolverEntry).resolver !== undefined;
}

export interface BinaryManifest {
  schemaVersion: 1;
  binaries: Record<BinaryKind, BinaryManifestEntry>;
  signature: string; // base64 Ed25519 over canonical JSON of binaries
}

export interface BinaryStatus {
  kind: BinaryKind;
  version: string;
  installed: boolean;
  path?: string;
}

// Resolved download metadata for a not-yet-installed binary, surfaced in the
// startup download confirmation. `version` is the resolved release (or
// "unknown" when it couldn't be resolved); `sizeBytes` is the download size
// when known (GitHub asset size on beta, HEAD Content-Length on stable).
export interface BinaryProbeResult {
  kind: BinaryKind;
  version: string;
  sizeBytes?: number;
}

// Core update manifest (separate from binaries).
//
// `binaries` carries the per-triple tomat-core executables. `workers` carries
// the platform-independent .ts files (embeddingWorker, ttsWorker, toolWorker)
// that are spawned at runtime by the core; shipping them separately keeps the
// compiled core binary lean (their transformers/onnxruntime deps would
// otherwise add ~1.5 GB). `helpers` carries per-triple binaries that ship next
// to core in ~/.tomat/<channel>/core/bin/ and are installed (and swapped on
// self-update) by the same code path: tomat-core-keychain (Rust crate) and
// tomat-core-updater (Rust crate; the binary that performs the swap). They
// are invoked via subprocess.
export interface CoreManifest {
  schemaVersion: 1;
  version: string;
  binaries: Array<{ triple: Triple; url: string; sha256: string }>;
  workers: Array<{ name: string; url: string; sha256: string }>;
  helpers: Array<{ name: string; triple: Triple; url: string; sha256: string }>;
  signature: string;
}

export type SidecarKind = "llama" | "whisper" | "tts" | "tool";

export type SidecarStatus = "Disabled" | "Loading" | "Running" | "Error";

export interface SidecarSnapshot {
  kind: SidecarKind;
  status: SidecarStatus;
  pid?: number;
  rssMb?: number;
  cpuPct?: number;
  message?: string;
  // 0..1 progress hint for the load phase (e.g. model download). Absent
  // once running.
  progress?: number;
}
