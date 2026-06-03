// Sidecar boot orchestrator. Starts llama-server and whisper-server based
// on the current settings, then re-evaluates on every settings PATCH and
// (re)starts / stops the affected sidecar.
//
// This is the only place that decides whether a sidecar should be running.
// `sidecarManager()` is a generic supervisor; the kind-specific gates
// (provider, enabled toggle, model file existence) live here.

import { buildLlamaStartOptions, llamaStartArgsFromSettings } from "../sidecars/llama.ts";
import { errMessage } from "@tomat/shared";
import { buildWhisperStartOptions, whisperStartArgsFromSettings } from "../sidecars/whisper.ts";
import { sidecarManager } from "../sidecars/manager.ts";
import { loadCoreSettings, subscribeCoreSettings } from "./core-settings.ts";
import { downloadManager } from "../downloads/manager.ts";
import { onBinaryInstalled } from "../binaries/manager.ts";
import { binaryName } from "../binaries/versions.ts";
import { binPath } from "../paths.ts";
import { getLogger } from "../shared/log.ts";

const log = getLogger("sidecar-boot");

// Keys that, when changed, should trigger a llama-server restart with the
// new args (or a stop if the gating condition flipped off).
const LLAMA_KEYS = new Set([
  "llm.provider",
  "llm.modelPath",
  "llm.mmprojPath",
  "llm.supportImages",
  "llm.host",
  "llm.port",
  "llm.threads",
  "llm.contextSize",
  "llm.reasoning",
  "llm.reasoningBudget",
  "llm.mmap",
  "llm.webui",
]);

const WHISPER_KEYS = new Set([
  "stt.enabled",
  "stt.provider",
  "stt.modelPath",
  "stt.host",
  "stt.port",
  "stt.threads",
]);

let initialized = false;

// Tracks the last-seen status per download id so the subscriber can fire
// only on the "just transitioned to Completed" edge rather than every
// progress tick.
const lastSeenStatus = new Map<string, string>();

/** Called once from main.ts at startup. Boots the relevant sidecars from
 *  the persisted settings, then installs a listener for live restarts and
 *  a download-completion hook for auto-restart after a model finishes
 *  downloading. */
export async function initSidecarBoot(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const settings = await loadCoreSettings();
  await applyLlama(settings).catch(logErr("llama"));
  await applyWhisper(settings).catch(logErr("whisper"));
  subscribeCoreSettings(async (next, changed) => {
    if (anyOverlap(changed, LLAMA_KEYS)) {
      await applyLlama(next).catch(logErr("llama"));
    }
    if (anyOverlap(changed, WHISPER_KEYS)) {
      await applyWhisper(next).catch(logErr("whisper"));
    }
  });
  // When an llm/stt model file finishes downloading, retry the affected
  // sidecar. Without this hook the user has to manually toggle settings
  // (or restart core) after the download completes to actually pick up
  // the new file.
  downloadManager().subscribe((snap) => {
    const justCompleted = new Set<string>();
    for (const entry of snap) {
      const prev = lastSeenStatus.get(entry.id);
      if (prev !== "Completed" && entry.status === "Completed") {
        justCompleted.add(entry.groupId);
      }
      lastSeenStatus.set(entry.id, entry.status);
    }
    if (justCompleted.size === 0) return;
    void (async () => {
      const s = await loadCoreSettings();
      if (justCompleted.has("llm")) {
        await applyLlama(s).catch(logErr("llama"));
      }
      if (justCompleted.has("stt")) {
        await applyWhisper(s).catch(logErr("whisper"));
      }
    })();
  });
  // Binary installs don't surface through the download-completion hook above:
  // their model `groupId` is `binary:<kind>` and the .tar.gz download reports
  // Completed *before* extraction finishes, so the on-disk executable isn't
  // there yet at that point. `onBinaryInstalled` fires after extraction, so a
  // sidecar whose binary was missing (and was therefore left Disabled) can
  // start once its binary actually lands.
  onBinaryInstalled((kind) => {
    void (async () => {
      const s = await loadCoreSettings();
      if (kind === "llama-server") await applyLlama(s).catch(logErr("llama"));
      if (kind === "whisper-server") await applyWhisper(s).catch(logErr("whisper"));
    })();
  });
}

export async function applyLlama(settings: Record<string, unknown>): Promise<void> {
  const args = llamaStartArgsFromSettings(settings);
  if (!args) {
    await sidecarManager().stop("llama");
    return;
  }
  if (!(await fileExists(args.modelPath))) {
    log.warn(
      `llama-server model not on disk: ${args.modelPath}; sidecar stays ` +
        `Disabled until the user downloads it (requirements flow). The ` +
        `download-completion hook re-applies once the file lands`,
    );
    await sidecarManager().stop("llama");
    return;
  }
  // A configured-but-missing mmproj would be passed to llama-server as
  // `--mmproj <missing>`, which makes the whole sidecar fail to boot (not just
  // vision). The requirements flow lists mmproj for download; until it lands,
  // stay Disabled rather than spawn a doomed process. The download-completion
  // hook re-applies once the file arrives.
  if (args.mmprojPath && !(await fileExists(args.mmprojPath))) {
    log.warn(
      `llama-server mmproj not on disk: ${args.mmprojPath}; sidecar stays ` +
        `Disabled until the user downloads it (requirements flow)`,
    );
    await sidecarManager().stop("llama");
    return;
  }
  if (!(await fileExists(binPath(binaryName("llama-server"))))) {
    log.warn(
      `llama-server binary not installed; sidecar stays Disabled until it ` +
        `is downloaded (the client re-prompts the pending download on the ` +
        `next settings change)`,
    );
    await sidecarManager().stop("llama");
    return;
  }
  await sidecarManager().restart("llama", buildLlamaStartOptions(args));
}

async function applyWhisper(settings: Record<string, unknown>): Promise<void> {
  const args = whisperStartArgsFromSettings(settings);
  if (!args) {
    await sidecarManager().stop("whisper");
    return;
  }
  if (!(await fileExists(args.modelPath))) {
    log.warn(
      `whisper-server model not on disk: ${args.modelPath}; sidecar stays ` +
        `Disabled until the user downloads it (requirements flow). The ` +
        `download-completion hook re-applies once the file lands`,
    );
    await sidecarManager().stop("whisper");
    return;
  }
  if (!(await fileExists(binPath(binaryName("whisper-server"))))) {
    log.warn(
      `whisper-server binary not installed; sidecar stays Disabled until it ` +
        `is downloaded (the client re-prompts the pending download on the ` +
        `next settings change)`,
    );
    await sidecarManager().stop("whisper");
    return;
  }
  await sidecarManager().restart("whisper", buildWhisperStartOptions(args));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}

function anyOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const k of a) if (b.has(k)) return true;
  return false;
}

function logErr(kind: string) {
  return (err: unknown) => {
    log.error(`${kind} apply failed: ${errMessage(err)}`);
  };
}
