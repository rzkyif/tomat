// The runtime-abstraction layer the engine is built on. Every stateful or
// OS-touching capability the portable services need is reached through a `Host`
// the embedder supplies: the Deno service (`@tomat/core`) wires a `DenoHost`; a
// future mobile client wires a webview host. The engine itself imports no
// `Deno.*`, `@db/sqlite`, `@tauri-apps/*`, or `node:*` (enforced by the
// `tomat/no-host-import` lint rule), so the same source runs in either runtime.

import type { ToolHost } from "./services/tool-host.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

// What the running host can do. The engine gates subsystems on these rather than
// assuming a Deno service: a webview host leaves them all false and the engine
// never reaches sidecar / subprocess code.
export interface HostCapabilities {
  // Local model / STT / TTS / embedding inference is available (a Deno service
  // that can spawn sidecars). False on mobile: the engine routes to external
  // providers only.
  localInference: boolean;
  // The host can spawn subprocesses (tool-worker sandbox, stdio MCP, helper
  // binaries). False on mobile.
  subprocess: boolean;
  // Remote (HTTP-transport) MCP servers are reachable.
  remoteMcp: boolean;
}

// Options for an atomic write. `restrictPermissions` asks the host to make the
// file owner-only (POSIX 0600 on desktop); a host whose storage is already
// app-private (mobile) may ignore it.
export interface WriteOpts {
  restrictPermissions?: boolean;
}

// Async filesystem. Atomic writers do tmp-file + rename, matching the core's
// existing writeAtomic. `stat` returns null for a missing path rather than
// throwing, so callers branch without catching.
export interface HostFs {
  readTextFile(path: string): Promise<string>;
  writeTextFileAtomic(path: string, text: string, opts?: WriteOpts): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFileAtomic(path: string, bytes: Uint8Array, opts?: WriteOpts): Promise<void>;
  stat(path: string): Promise<{ size: number; isDir: boolean } | null>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
}

// A value bindable to a SQL statement parameter. Matches the native driver's
// accepted set so the engine stays driver-agnostic without importing one.
export type SqlBindValue =
  | boolean
  | number
  | bigint
  | string
  | null
  | undefined
  | Uint8Array
  | Date;

// Synchronous SQLite: the exact subset the core's ~250 db() call sites use, so
// moving them behind the host changes no call site. The Deno host adapts
// `@db/sqlite`; a mobile host adapts an in-memory WASM SQLite with a debounced
// flush through `HostFs`.
export interface HostDb {
  exec(sql: string): void;
  prepare(sql: string): HostStmt;
  close(): void;
}

// One prepared statement. `run` returns the affected-row count (the module
// broker's execute op reads it). `get`/`all` assert the caller's row type,
// exactly as the callers already do against the native driver.
export interface HostStmt {
  get<T = unknown>(...params: SqlBindValue[]): T | undefined;
  all<T = unknown>(...params: SqlBindValue[]): T[];
  run(...params: SqlBindValue[]): number;
  value<T = unknown>(...params: SqlBindValue[]): T | undefined;
  finalize(): void;
}

// Secret storage for the vault master key (and nothing else): the OS keychain on
// desktop, the platform secure store on mobile.
export interface HostSecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// Local (on-device) inference endpoints, present only on a host that can run the
// llama / embed sidecars. Absent entirely on a host without local inference
// (mobile), where LLM + embeddings are external-only.
export interface LocalEndpoints {
  // Default loopback port for the local llama-server, used as the fallback when
  // the user hasn't overridden llm.port (channel-adjusted on desktop).
  llmDefaultPort(): number;
  // The loopback embed sidecar's OpenAI-style endpoint + model id, or null when
  // the local embedding model isn't available (so the caller falls back /
  // degrades).
  embedEndpoint(): Promise<{ url: string; model: string } | null>;
  // Local speech-to-text via the speech sidecar, queued behind the single engine
  // for fair multi-client behavior (`clientId` keys that fairness). `signal`
  // bounds/cancels the call.
  transcribe(audio: File, clientId: string, signal?: AbortSignal): Promise<string>;
  // Local text-to-speech (Kokoro) to WAV bytes, queued the same way.
  synthesize(
    text: string,
    voice: string | undefined,
    speed: number | undefined,
    clientId: string,
  ): Promise<Uint8Array>;
}

// Everything the engine needs from its runtime. Injected once at init().
export interface Host {
  // Root of the engine's on-disk state; EnginePaths derives every file/dir from
  // it. Desktop passes the core root; mobile passes an app-private dir.
  rootDir: string;
  // Environment / config lookup, replacing Deno.env.get.
  config(key: string): string | undefined;
  capabilities: HostCapabilities;
  fs: HostFs;
  // Open (or return the cached handle for) a SQLite database at an absolute
  // path: the main core.sqlite plus any per-extension database.
  openDb(absPath: string): HostDb;
  secureStore: HostSecureStore;
  // Local inference endpoint provider, present only when the host can run the
  // llama / embed sidecars (capabilities.localInference). Absent on external-only
  // hosts (mobile).
  localEndpoints?: LocalEndpoints;
  // Tool catalog + execution provider (extension registry + worker sandbox + MCP
  // client). A mobile host supplies a remote-MCP-only implementation.
  tools?: ToolHost;
  log(level: LogLevel, scope: string, message: string): void;
  // Current wall-clock ms; defaults to Date.now when omitted.
  now?(): number;
}
