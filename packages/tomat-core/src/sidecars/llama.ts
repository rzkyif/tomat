// llama-server arg builder + readiness wiring.
//
// Reads from the local `llm.*` settings (model path, host, port, threads,
// context size, reasoning toggles, mmproj). Returns the `StartOptions`
// the SidecarManager needs to spawn `llama-server`. Caller is responsible
// for resolving the model path; this module assumes the file exists.

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
  reasoning: "off" | "on" | "auto";
  reasoningBudget?: number;
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
  const modelSpec = strSetting(settings, "llm.modelPath", "");
  if (!modelSpec) return null;
  const supportImages = boolSetting(settings, "llm.supportImages", true);
  const mmprojSpec = supportImages ? strSetting(settings, "llm.mmprojPath", "") : "";
  return {
    modelPath: resolveHfPath(modelSpec),
    mmprojPath: mmprojSpec ? resolveHfPath(mmprojSpec) : undefined,
    host: strSetting(settings, "llm.host", "127.0.0.1"),
    port: strSetting(settings, "llm.port", String(llmPort())),
    threads: numSetting(settings, "llm.threads", 4),
    contextSize: numSetting(settings, "llm.contextSize", 4096),
    reasoning: strSetting(settings, "llm.reasoning", "off") as "off" | "on" | "auto",
    reasoningBudget: optionalNumSetting(settings, "llm.reasoningBudget"),
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
    // Multi-stream chat needs `--parallel N --cont-batching`. Plan §3
    // default is 4 slots.
    "--parallel",
    "4",
    "--cont-batching",
  ];
  if (args.mmap) argv.push("--mmap");
  if (typeof args.gpuLayers === "number") argv.push("--n-gpu-layers", String(args.gpuLayers));
  if (args.flashAttn) argv.push("--flash-attn", "on");
  if (args.reasoning !== "off") {
    argv.push("--reasoning", args.reasoning);
    if (typeof args.reasoningBudget === "number" && args.reasoningBudget > 0) {
      argv.push("--reasoning-budget", String(args.reasoningBudget));
    }
  }
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
function optionalNumSetting(s: Record<string, unknown>, k: string): number | undefined {
  const v = s[k];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}
