/**
 * Manages the in-browser voice activity detector — the thing that listens
 * to the microphone and decides when the user is talking. Owns the VAD
 * model's lifecycle (load, start, pause, destroy), exposes its state for
 * the UI, and hands each detected speech segment to a caller-supplied
 * callback.
 */

import { listen } from "@tauri-apps/api/event";
import { playBeep } from "$lib/shared/beep";
import { settingsState } from "$lib/state/settings.svelte";

class VadManager {
  enabled = $state(false);
  listening = $state(false);
  loading = $state(false);

  private instance: any = null;
  private pendingDisable = false;
  private pausedByHide = false;
  private unlistenVisibility: (() => void) | null = null;
  // Incremented on every enable() and detach(); any in-flight init whose token
  // doesn't match the current value is treated as superseded and cleaned up.
  private enableToken = 0;
  private onSpeech: ((audio: Float32Array) => Promise<void>) | null = null;

  /** Wire up the window-visibility listener and register the speech handler.
   *  Safe to call multiple times - re-attaching replaces the previous hook. */
  async attach(onSpeech: (audio: Float32Array) => Promise<void>): Promise<void> {
    this.onSpeech = onSpeech;
    if (this.unlistenVisibility) return;
    this.unlistenVisibility = await listen<boolean>(
      "window-visibility",
      async ({ payload: visible }) => {
        if (!visible && this.enabled && this.instance) {
          if (settingsState.currentSettings["stt.activation"] === "sticky") {
            this.instance.pause();
            this.listening = false;
            this.pausedByHide = true;
          } else {
            await this.disableNow();
          }
        } else if (visible && this.pausedByHide && this.instance) {
          this.instance.start();
          this.pausedByHide = false;
        }
      },
    );
  }

  detach() {
    this.enableToken++;
    if (this.instance) {
      this.instance.destroy();
      this.instance = null;
    }
    this.unlistenVisibility?.();
    this.unlistenVisibility = null;
    this.onSpeech = null;
    this.enabled = false;
    this.listening = false;
    this.loading = false;
    this.pendingDisable = false;
    this.pausedByHide = false;
  }

  /** User-facing toggle: if enabled, disables (deferring until current
   *  speech segment finishes); if disabled, enables. */
  async toggle(): Promise<void> {
    if (this.enabled) {
      if (this.listening && this.instance && !this.pendingDisable) {
        this.pendingDisable = true;
        return;
      }
      if (this.pendingDisable) return;
      await this.disableNow();
    } else {
      await this.enable();
    }
  }

  private async disableNow(): Promise<void> {
    if (this.instance) {
      this.instance.destroy();
      this.instance = null;
    }
    this.enabled = false;
    this.listening = false;
    this.pendingDisable = false;
    playBeep("off");
    if (settingsState.currentSettings["stt.activation"] === "sticky") {
      await settingsState.updateSetting("stt.vadPersistedState", false);
    }
  }

  private async enable(): Promise<void> {
    const token = ++this.enableToken;
    this.loading = true;
    // Turning on voice input means the user wants to speak, not listen -
    // cut any TTS that's currently playing or queued.
    void import("$lib/state/tts.svelte").then(({ ttsState }) => ttsState.reset());
    try {
      const { MicVAD } = await import("@ricky0123/vad-web");
      const instance = await MicVAD.new({
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        model: "v5",
        onSpeechStart: () => {
          this.listening = true;
        },
        onSpeechEnd: async (audio: Float32Array) => {
          this.listening = false;
          if (this.onSpeech) await this.onSpeech(audio);
          if (this.pendingDisable) await this.disableNow();
          else if (
            settingsState.currentSettings["stt.activation"] === "manual" &&
            !settingsState.currentSettings["stt.llmChainTranscription"]
          )
            await this.disableNow();
        },
        onVADMisfire: () => {
          this.listening = false;
          if (this.pendingDisable) void this.disableNow();
          else if (
            settingsState.currentSettings["stt.activation"] === "manual" &&
            !settingsState.currentSettings["stt.llmChainTranscription"]
          )
            void this.disableNow();
        },
      });

      if (token !== this.enableToken) {
        instance.destroy();
        return;
      }

      this.instance = instance;
      this.instance.start();
      this.enabled = true;
      playBeep("on");
      if (settingsState.currentSettings["stt.activation"] === "sticky") {
        await settingsState.updateSetting("stt.vadPersistedState", true);
      }
    } catch (err) {
      console.error("[vad] Failed to initialize:", err);
      this.enabled = false;
    } finally {
      this.loading = false;
    }
  }
}

export const vadManager = new VadManager();
