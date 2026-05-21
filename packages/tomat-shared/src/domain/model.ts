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

export type Triple = typeof TRIPLES[number];

export const BINARY_KINDS = [
  "llama-server",
  "whisper-server",
  "deno",
] as const;

export type BinaryKind = typeof BINARY_KINDS[number];

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

export type DownloadStatus =
  | "Pending"
  | "Downloading"
  | "Completed"
  | "Error"
  | "Cancelled";

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
}

// Pinned binary metadata from the runtime-fetched manifest.
export interface BinaryManifestEntry {
  version: string;
  platforms: Record<Triple, { url: string; sha256: string }>;
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

// Core update manifest (separate from binaries).
//
// `binaries` carries the per-triple tomat-core + tomat-core-updater
// executables. `workers` carries the platform-independent .ts files
// (embeddingWorker, ttsWorker, toolWorker) that are spawned at runtime by
// the core; shipping them separately keeps the compiled core binary lean
// (their transformers/onnxruntime deps would otherwise add ~1.5 GB).
// `helpers` carries per-triple native helper binaries built from the
// in-repo Rust crate (tomat-core-keychain). They live next to core in
// ~/.tomat/core/bin/ and are invoked via subprocess.
export interface CoreManifest {
  schemaVersion: 1;
  version: string;
  binaries: Array<{ triple: Triple; url: string; sha256: string }>;
  workers: Array<{ name: string; url: string; sha256: string }>;
  helpers: Array<
    { name: string; triple: Triple; url: string; sha256: string }
  >;
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
