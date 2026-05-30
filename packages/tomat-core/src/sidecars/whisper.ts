// whisper-server arg builder + readiness wiring.
//
// Mirrors llama.ts but for the STT sidecar. Only kicks in when the user
// has stt.enabled=true and stt.provider="local".

import { join } from "@std/path";
import { binPath, paths, sttPort } from "../paths.ts";
import { platformExe } from "../binaries/versions.ts";
import { resolveHfPath } from "../models/manager.ts";
import type { StartOptions } from "./types.ts";

export interface WhisperStartArgs {
  modelPath: string;
  host: string;
  port: string;
  threads: number;
}

export function whisperStartArgsFromSettings(
  settings: Record<string, unknown>,
): WhisperStartArgs | null {
  if (!boolSetting(settings, "stt.enabled", true)) return null;
  if (strSetting(settings, "stt.provider", "local") !== "local") return null;
  const modelSpec = strSetting(settings, "stt.modelPath", "");
  if (!modelSpec) return null;
  return {
    modelPath: resolveHfPath(modelSpec),
    host: strSetting(settings, "stt.host", "127.0.0.1"),
    port: strSetting(settings, "stt.port", String(sttPort())),
    threads: numSetting(settings, "stt.threads", 4),
  };
}

export function buildWhisperStartOptions(args: WhisperStartArgs): StartOptions {
  const argv: string[] = [
    "-m",
    args.modelPath,
    "-t",
    String(args.threads),
    "--host",
    args.host,
    "--port",
    args.port,
  ];
  return {
    binary: binPath(`whisper-server${platformExe()}`),
    args: argv,
    readiness: {
      kind: "http",
      url: `http://${args.host}:${args.port}/`,
    },
    libraryDir: join(paths().binDir, "lib"),
    startupTimeoutMs: 60_000,
  };
}

function strSetting(
  s: Record<string, unknown>,
  k: string,
  def: string,
): string {
  const v = s[k];
  return typeof v === "string" ? v : def;
}
function boolSetting(
  s: Record<string, unknown>,
  k: string,
  def: boolean,
): boolean {
  const v = s[k];
  return typeof v === "boolean" ? v : def;
}
function numSetting(
  s: Record<string, unknown>,
  k: string,
  def: number,
): number {
  const v = s[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}
