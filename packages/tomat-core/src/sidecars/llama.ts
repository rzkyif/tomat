// llama-server arg builder + readiness wiring.
//
// Reads from the local `llm.*` settings (model path, host, port, threads,
// context size, mmproj). Thinking and sampling are sent per request, not at
// boot. Returns the `StartOptions`
// the SidecarManager needs to spawn `llama-server`. Caller is responsible
// for resolving the model path; this module assumes the file exists.

import { getDefaultSettings } from "@tomat/shared";
import { binPath, llmPort, paths } from "../paths.ts";
import { libDirFor, platformExe } from "../binaries/versions.ts";
import { resolveHfPath } from "../models/manager.ts";
import type { StartOptions } from "./types.ts";

export interface LlamaStartArgs {
  modelPath: string;
  mmprojPath?: string;
  host: string;
  port: string;
  threads: number;
  contextSize: number;
  mmap: boolean;
  webui: boolean;
  /** Layers to offload to the GPU. 0 = CPU only; a large value (e.g. 999) =
   *  offload all. Omitted/undefined lets llama.cpp use its own default. */
  gpuLayers?: number;
  /** Enable flash attention (faster attention; broadly supported). */
  flashAttn: boolean;
}

export function llamaStartArgsFromSettings(
  settings: Record<string, unknown>,
): LlamaStartArgs | null {
  const provider = strSetting(settings, "llm.provider", "local");
  if (provider !== "local") return null;
  // Settings arrive sparse (only user-changed keys are persisted), so
  // untouched model paths must fall back to the schema defaults, not "".
  // Ports keep their channel-aware fallbacks instead: the schema's port
  // defaults are stable-channel values.
  const modelSpec = strSetting(settings, "llm.modelPath", schemaDefault("llm.modelPath"));
  if (!modelSpec) return null;
  const supportImages = boolSetting(settings, "llm.supportImages", true);
  const mmprojSpec = supportImages
    ? strSetting(settings, "llm.mmprojPath", schemaDefault("llm.mmprojPath"))
    : "";
  return {
    modelPath: resolveHfPath(modelSpec),
    mmprojPath: mmprojSpec ? resolveHfPath(mmprojSpec) : undefined,
    host: strSetting(settings, "llm.host", "127.0.0.1"),
    port: strSetting(settings, "llm.port", String(llmPort())),
    threads: numSetting(settings, "llm.threads", 4),
    contextSize: numSetting(settings, "llm.contextSize", 4096),
    mmap: boolSetting(settings, "llm.mmap", true),
    webui: boolSetting(settings, "llm.webui", false),
    gpuLayers: presentNumSetting(settings, "llm.gpuLayers"),
    flashAttn: boolSetting(settings, "llm.flashAttn", false),
  };
}

/** Build a StartOptions from the parsed args. Caller passes this to
 *  `sidecarManager().start("llama", opts)`. */
export function buildLlamaStartOptions(args: LlamaStartArgs): StartOptions {
  const argv: string[] = [
    "-m",
    args.modelPath,
    "-c",
    String(args.contextSize),
    "-t",
    String(args.threads),
    "--host",
    args.host,
    "--port",
    args.port,
    // One serial slot: the whole context window goes to a single turn.
    // `--parallel N` splits the context evenly across N slots (each turn gets
    // ctx/N), which starves a thinking model and can cut it off mid-thought.
    // Concurrent work (background single-shot calls, a second client) queues
    // on the server instead; the scheduler also serializes ahead of it.
    "--parallel",
    "1",
    // Thinking on/off and its token budget are sent per request now (so editing
    // them needs no server restart). Pin the parse format so the server always
    // extracts the model's thoughts into `reasoning_content`, which the stream
    // reader keys on, regardless of the llama.cpp default.
    "--reasoning-format",
    "deepseek",
  ];
  if (args.mmap) argv.push("--mmap");
  if (typeof args.gpuLayers === "number") argv.push("--n-gpu-layers", String(args.gpuLayers));
  if (args.flashAttn) argv.push("--flash-attn", "on");
  // The llama.cpp web UI is unauthenticated. Only ever enable it when the
  // server is bound to loopback (local debugging); if the sidecar is reachable
  // from the network (a non-loopback host), force it off so it can't be hit by
  // other devices on the LAN.
  const hostIsLoopback =
    args.host === "127.0.0.1" || args.host === "localhost" || args.host === "::1";
  if (args.webui && hostIsLoopback) argv.push("--webui");
  else argv.push("--no-webui");
  if (args.mmprojPath) argv.push("--mmproj", args.mmprojPath);
  return {
    binary: binPath(`llama-server${platformExe()}`),
    args: argv,
    readiness: {
      kind: "http",
      url: `http://${args.host}:${args.port}/health`,
    },
    libraryDir: libDirFor(paths().binDir, "llama-server"),
    startupTimeoutMs: 60_000,
  };
}

function schemaDefault(key: string): string {
  const v = getDefaultSettings()[key];
  return typeof v === "string" ? v : "";
}

function strSetting(s: Record<string, unknown>, k: string, def: string): string {
  const v = s[k];
  return typeof v === "string" ? v : def;
}
function boolSetting(s: Record<string, unknown>, k: string, def: boolean): boolean {
  const v = s[k];
  return typeof v === "boolean" ? v : def;
}
function numSetting(s: Record<string, unknown>, k: string, def: number): number {
  const v = s[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}
/** Like optionalNumSetting but keeps 0 (a meaningful value for gpuLayers). Returns
 *  undefined only when the key is absent/blank/non-numeric. */
function presentNumSetting(s: Record<string, unknown>, k: string): number | undefined {
  const v = s[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
