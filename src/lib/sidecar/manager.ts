import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildArgs } from "$lib/shared/command";
import { serversState, settingsState } from "../state";

export type ServerStatus = "Disabled" | "Error" | "Downloading" | "Loading" | "Running";

export interface ServerStatusUpdate {
  server: "llm" | "stt" | "bun";
  status: ServerStatus;
  progress?: number;
  message?: string;
}

export async function setupSidecarListeners() {
  await listen<ServerStatusUpdate>("sidecar-status", (event) => {
    console.log("[sidecar:event]", event.payload);
    serversState.updateStatus(event.payload);
  });
}

export function computeArgs(type: "llm" | "stt", currentSettings: Record<string, any>): string[] {
  return buildArgs(type, currentSettings);
}

export async function restartServerIfNeed(type: "llm" | "stt") {
  const currentSettings = settingsState.currentSettings;
  const preset = currentSettings[`${type}.preset`];

  // External and disabled both mean "no local sidecar" - empty args trigger
  // the Disabled state in the backend, which terminates any running child
  // and emits the Disabled status. (Returning early here would leak a
  // running llama-server when the user switches from a local preset to
  // external.)
  if (preset === "external" || preset === "disabled") {
    await invoke("update_server_args", {
      server: type,
      args: [],
      modelPath: null,
      mmprojPath: null,
      checkUrl: null,
    });
    return;
  }

  const modelPath = currentSettings[`${type}.modelPath`];
  const args = computeArgs(type, currentSettings);
  const host = currentSettings[`${type}.host`] || "127.0.0.1";
  const port = currentSettings[`${type}.port`] || (type === "llm" ? "7701" : "7702");
  const checkUrl = `http://${host}:${port}/health`;

  const mmprojPath =
    type === "llm" && currentSettings["llm.supportImages"]
      ? currentSettings["llm.mmprojPath"] || null
      : null;

  await invoke("update_server_args", {
    server: type,
    args,
    modelPath,
    mmprojPath,
    checkUrl,
  });
}
