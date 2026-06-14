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

export const BINARY_KINDS = ["llama-server", "tomat-core-speech", "deno"] as const;

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
//  - Resolver (latest channel): an upstream GitHub repo + per-triple asset name
//    patterns. The core resolves the LATEST release at runtime, so upstream
//    updates reach latest users without us re-releasing. The signed manifest
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
  /** When set, resolve this exact release tag instead of the latest. Pins a
   *  binary on EVERY channel (latest/dev resolve at runtime, stable pins from
   *  the same tag at release time), so bumping it is a deliberate edit. */
  pinnedTag?: string;
}

export interface BinaryManifestResolverEntry {
  resolver: UpstreamResolver;
}

// Single source of truth for the upstream resolver config per sidecar binary:
// the GitHub repo + per-triple asset-name pattern ("{tag}" expands to the
// release's tag_name). Consumed by:
//  - the release script: STABLE pins the current latest (URL + sha256) at
//    release time; LATEST embeds the resolver verbatim so the core resolves the
//    latest release at runtime.
//  - a DEV core: builds resolver entries from this in-code (dev has no
//    published manifest), so a from-source build pulls the latest upstream
//    sidecar release exactly like latest.
// Partial: self-hosted kinds (tomat-core-speech) have no upstream resolver. The
// release builds and pins them directly into binaries.json (scripts/release/
// core.ts composeBinaryManifest), so they are absent from this map.
export const UPSTREAM_BINARIES: Partial<Record<BinaryKind, UpstreamResolver>> = {
  "llama-server": {
    repo: "ggml-org/llama.cpp",
    assets: {
      "aarch64-apple-darwin": "llama-{tag}-bin-macos-arm64.tar.gz",
      "x86_64-apple-darwin": "llama-{tag}-bin-macos-x64.tar.gz",
      "aarch64-unknown-linux-gnu": "llama-{tag}-bin-ubuntu-arm64.tar.gz",
      "x86_64-unknown-linux-gnu": "llama-{tag}-bin-ubuntu-x64.tar.gz",
      "x86_64-pc-windows-msvc": "llama-{tag}-bin-win-cpu-x64.zip",
      "aarch64-pc-windows-msvc": "llama-{tag}-bin-win-cpu-arm64.zip",
    },
  },
  deno: {
    repo: "denoland/deno",
    // Pinned on every channel: tool-worker permission prompts are parsed
    // from this version's prompt wording (tomat-core/src/toolkits/
    // prompt-parser.ts). Bump deliberately and re-run the live-probe test
    // (prompt-live-probe.test.ts) against the new release first.
    pinnedTag: "v2.8.2",
    assets: {
      "aarch64-apple-darwin": "deno-aarch64-apple-darwin.zip",
      "x86_64-apple-darwin": "deno-x86_64-apple-darwin.zip",
      "aarch64-unknown-linux-gnu": "deno-aarch64-unknown-linux-gnu.zip",
      "x86_64-unknown-linux-gnu": "deno-x86_64-unknown-linux-gnu.zip",
      "x86_64-pc-windows-msvc": "deno-x86_64-pc-windows-msvc.zip",
      "aarch64-pc-windows-msvc": "deno-aarch64-pc-windows-msvc.zip",
    },
  },
};

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
// when known (GitHub asset size on latest, HEAD Content-Length on stable).
export interface BinaryProbeResult {
  kind: BinaryKind;
  version: string;
  sizeBytes?: number;
}

// --- requirements -----------------------------------------------------------
//
// The single source of truth for "what files does the current configuration
// need" (models + sidecar binaries). The core computes a RequirementsSnapshot
// from these and broadcasts it; the client renders one pending-downloads popup.

/** Synthetic source prefix for a sidecar binary surfaced in the same list as
 *  HF model files (e.g. `binary:llama-server`). */
export const BINARY_SOURCE_PREFIX = "binary:";

export function binarySource(kind: BinaryKind): string {
  return `${BINARY_SOURCE_PREFIX}${kind}`;
}
export function isBinarySource(source: string): boolean {
  return source.startsWith(BINARY_SOURCE_PREFIX);
}
export function binarySourceToKind(source: string): BinaryKind {
  return source.slice(BINARY_SOURCE_PREFIX.length) as BinaryKind;
}

export type RequirementGroup = "llm" | "stt" | "tts" | "embed";

/** One thing the current config needs present on disk. Shaped so the `missing`
 *  subset is directly renderable by the download confirm modal. */
export interface RequiredFile {
  /** HF model spec ("@u/r/branch/file"), or `binary:<kind>`. */
  source: string;
  type: "model" | "binary";
  group: RequirementGroup | "binary";
  present: boolean;
  /** A binary with no upstream asset on this platform. Kept in `required` for
   *  visibility but excluded from `missing` so it never blocks the app. */
  unavailable?: boolean;
  sizeHint?: number;
  version?: string;
}

export interface RequirementsSnapshot {
  required: RequiredFile[];
  /** Subset of `required` that is not present and not unavailable. Drives the
   *  popup and the app's pending gate. */
  missing: RequiredFile[];
}

export interface RequiredModelRef {
  source: string;
  group: RequirementGroup;
}

/** Sidecar binary kinds the settings require: `deno` always (runs the tool
 *  worker); `llama-server` always (local chat when the LLM provider is local,
 *  plus embeddings for tool-relevance, which always run on a second llama-server
 *  instance); `tomat-core-speech` iff local STT or TTS is enabled (one binary
 *  serves both Whisper STT and Kokoro TTS). */
export function requiredBinaryKinds(s: Record<string, unknown>): BinaryKind[] {
  const out: BinaryKind[] = ["deno", "llama-server"];
  const sttLocal = !!s["stt.enabled"] && s["stt.provider"] !== "external";
  if (sttLocal || !!s["tts.enabled"]) out.push("tomat-core-speech");
  return out;
}

/** Triples a self-hosted (no upstream resolver) binary cannot run on.
 *  tomat-core-speech statically links the sherpa-onnx native runtime, which has
 *  no windows-aarch64 prebuilt, so the speech binary can't be produced there. */
const SELF_HOSTED_UNSUPPORTED: Partial<Record<BinaryKind, ReadonlySet<Triple>>> = {
  "tomat-core-speech": new Set<Triple>(["aarch64-pc-windows-msvc"]),
};

/** True when `kind` can never be installed on `triple` (so it's marked
 *  `unavailable` rather than perpetually `missing`). Resolver-backed kinds have
 *  no upstream asset for the triple; self-hosted kinds (pinned directly into
 *  binaries.json) are available everywhere except their statically-known
 *  unsupported triples. */
export function binaryUnavailableOnTriple(kind: BinaryKind, triple: Triple): boolean {
  const resolver = UPSTREAM_BINARIES[kind];
  if (resolver) return resolver.assets[triple] === undefined;
  return SELF_HOSTED_UNSUPPORTED[kind]?.has(triple) ?? false;
}

// Core update manifest (separate from binaries).
//
// `binaries` carries the per-triple tomat-core executables. `workers` carries
// the platform-independent .ts file(s) (just toolWorker now) spawned at runtime
// by the core; shipping them separately from the compiled binary keeps
// deno-compile's embedded-dependency set scoped to the core's own graph rather
// than the whole workspace. `helpers` carries per-triple binaries that ship next
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

// Signed manifest for the CDN-distributed built-in toolkit. Mirrors CoreManifest:
// the whole object minus `signature` is canonicalized + Ed25519-signed at release
// time, and the runtime verifier reconstructs the same payload by stripping
// `signature`. `version` is the toolkit's package.json version; `tarballUrl`
// points at the gzipped tarball for that version and `sha256` is verified before
// extraction.
export interface BuiltinToolkitManifest {
  schemaVersion: 1;
  version: string;
  id: string;
  tarballUrl: string;
  sha256: string;
  signature: string;
}

export type SidecarKind = "llama" | "llama-embed" | "speech" | "tool";

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
