// tomat-core-speech sidecar: arg/readiness wiring plus the /configure, /speak,
// and /transcribe HTTP clients for the one resident process that serves both
// Whisper speech-to-text and Kokoro text-to-speech.
//
// Which engines are loaded is the "desired state" derived from settings: local
// STT (stt.enabled + local provider + the whisper bundle on disk) and/or TTS
// (tts.enabled + the kokoro bundle on disk). espeak-ng-data (the Kokoro
// phonemizer) is NOT a model download: it ships inside the binary's archive at
// bin/lib/tomat-core-speech/espeak-ng-data (see binaries/manager.ts) and is
// passed to the binary by path.
//
// Two ways to drive the binary, both used by sidecar-boot's applySpeech:
//   - start flags (--stt-* / --tts-*): the freshly-spawned process loads those
//     engines before it binds, so HTTP readiness == models loaded.
//   - POST /configure {stt, tts}: the running process (re)loads or drops each
//     engine in place. Dropping one frees its model's memory while the other
//     stays resident, with no restart - preserving per-module unload-on-disable.

import { join } from "@std/path";
import { errMessage, getDefaultSettings } from "@tomat/shared";
import { sttBundleFiles, TTS_MODEL_FILE, TTS_TOKENS_FILE, TTS_VOICES_FILE } from "@tomat/shared";
import { binPath, paths, speechPort } from "../paths.ts";
import { binaryName, libDirFor } from "../binaries/versions.ts";
import { resolveHfPath } from "../models/manager.ts";
import { AppError } from "../shared/errors.ts";
import type { StartOptions } from "./types.ts";

// Bound a single STT/TTS/configure call so a wedged inference (or a sidecar
// loading a multi-GB model) can't pin the caller forever.
const SPEECH_CALL_TIMEOUT_MS = 120_000;

/** Resolved on-disk paths for the Whisper engine (sherpa 3-file bundle). */
export interface SpeechSttConfig {
  encoder: string;
  decoder: string;
  tokens: string;
}

/** Resolved on-disk paths for the Kokoro engine. `espeakData` is the binary's
 *  bundled phonemizer dir, not a model download. */
export interface SpeechTtsConfig {
  model: string;
  voices: string;
  tokens: string;
  espeakData: string;
}

/** The full desired engine state of the speech process. A null engine means
 *  "not loaded" (disabled, or its files aren't on disk yet). */
export interface SpeechState {
  stt: SpeechSttConfig | null;
  tts: SpeechTtsConfig | null;
  host: string;
  port: string;
  threads: number;
}

/** The bundled espeak-ng-data dir, extracted next to the binary at install. */
function espeakDataDir(): string {
  return join(libDirFor(paths().binDir, "tomat-core-speech"), "espeak-ng-data");
}

/** Resolve the desired engine state from settings, gating each engine on its
 *  model files being present on disk: an enabled-but-not-yet-downloaded engine
 *  resolves to null so the process can still serve the other one, and the
 *  download-completion hook re-applies once the files land. The shared
 *  `stt.threads` knob drives the process thread count (STT is the heavier
 *  workload). Host/port are fixed loopback (the speech server is core-internal). */
export async function speechDesiredState(settings: Record<string, unknown>): Promise<SpeechState> {
  const threads = numSetting(settings, "stt.threads", 4);

  let stt: SpeechSttConfig | null = null;
  const sttLocal =
    boolSetting(settings, "stt.enabled", true) &&
    strSetting(settings, "stt.provider", "local") === "local";
  if (sttLocal) {
    const encoderSpec = strSetting(settings, "stt.modelPath", schemaDefault("stt.modelPath"));
    if (encoderSpec) {
      const bundle = sttBundleFiles(encoderSpec);
      const cfg = {
        encoder: resolveHfPath(bundle.encoder),
        decoder: resolveHfPath(bundle.decoder),
        tokens: resolveHfPath(bundle.tokens),
      };
      if (
        (await fileExists(cfg.encoder)) &&
        (await fileExists(cfg.decoder)) &&
        (await fileExists(cfg.tokens))
      ) {
        stt = cfg;
      }
    }
  }

  let tts: SpeechTtsConfig | null = null;
  if (boolSetting(settings, "tts.enabled", false)) {
    const cfg = {
      model: resolveHfPath(TTS_MODEL_FILE),
      voices: resolveHfPath(TTS_VOICES_FILE),
      tokens: resolveHfPath(TTS_TOKENS_FILE),
      espeakData: espeakDataDir(),
    };
    if (
      (await fileExists(cfg.model)) &&
      (await fileExists(cfg.voices)) &&
      (await fileExists(cfg.tokens))
    ) {
      tts = cfg;
    }
  }

  return { stt, tts, host: "127.0.0.1", port: String(speechPort()), threads };
}

/** Build StartOptions whose `--stt-*`/`--tts-*` flags load exactly the desired
 *  engines before the process binds, so HTTP readiness implies models loaded.
 *  No libraryDir: the binary statically links sherpa-onnx (no shared libs). */
export function buildSpeechStartOptions(state: SpeechState): StartOptions {
  const argv: string[] = [
    "--host",
    state.host,
    "--port",
    state.port,
    "--threads",
    String(state.threads),
  ];
  if (state.stt) {
    argv.push(
      "--stt-encoder",
      state.stt.encoder,
      "--stt-decoder",
      state.stt.decoder,
      "--stt-tokens",
      state.stt.tokens,
    );
  }
  if (state.tts) {
    argv.push(
      "--tts-model",
      state.tts.model,
      "--tts-voices",
      state.tts.voices,
      "--tts-tokens",
      state.tts.tokens,
      "--tts-espeak-data",
      state.tts.espeakData,
    );
  }
  return {
    binary: binPath(binaryName("tomat-core-speech")),
    args: argv,
    readiness: { kind: "http", url: `http://${state.host}:${state.port}/health` },
    // Loading the turbo int8 model (~1 GB) on CPU can take a while.
    startupTimeoutMs: SPEECH_CALL_TIMEOUT_MS,
  };
}

function speechBase(): string {
  return `http://127.0.0.1:${speechPort()}`;
}

/** Reconcile a running process to `state` in place (no restart): each engine is
 *  (re)loaded when its paths change and dropped when null. Idempotent. */
export async function configureSpeech(state: SpeechState): Promise<void> {
  const body = JSON.stringify({ stt: state.stt, tts: state.tts });
  let res: Response;
  try {
    res = await fetch(`${speechBase()}/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(SPEECH_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError("server_unavailable", `speech sidecar not reachable: ${errMessage(err)}`);
  }
  if (!res.ok) {
    throw new AppError(
      "provider_error",
      `speech /configure HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
}

/** Transcribe WAV bytes via the running sidecar. `signal` (the request abort)
 *  cancels the upstream inference if the client disconnects mid-decode. */
export async function speechTranscribe(audio: Blob, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(SPEECH_CALL_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${speechBase()}/transcribe`, {
      method: "POST",
      body: audio,
      signal: combined,
    });
  } catch (err) {
    throw new AppError("server_unavailable", `speech sidecar not reachable: ${errMessage(err)}`);
  }
  if (!res.ok) throw new AppError("provider_error", `speech /transcribe HTTP ${res.status}`);
  const json = (await res.json()) as { text?: string };
  return json.text ?? "";
}

/** Synthesize speech via the running sidecar; returns WAV bytes. `voice` is a
 *  tts.voice enum id (the binary maps it to a Kokoro speaker id via voices.rs). */
export async function speechSpeak(
  text: string,
  voice?: string,
  speed?: number,
): Promise<Uint8Array> {
  const payload: Record<string, unknown> = { text };
  if (voice) payload.voice = voice;
  if (typeof speed === "number" && Number.isFinite(speed)) payload.speed = speed;
  let res: Response;
  try {
    res = await fetch(`${speechBase()}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SPEECH_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError("server_unavailable", `speech sidecar not reachable: ${errMessage(err)}`);
  }
  if (!res.ok) {
    throw new AppError(
      "provider_error",
      `speech /speak HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
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
