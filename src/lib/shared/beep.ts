/**
 * Plays short beep sounds to give the user audio feedback for things like
 * the microphone turning on or off.
 */

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext {
  if (!audioCtx) {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    audioCtx = new Ctor() as AudioContext;
  }
  return audioCtx;
}

/**
 * Play a short sine-wave ping. "on" uses a higher pitch (880 Hz),
 * "off" uses a lower one (440 Hz). Silently no-ops if Web Audio isn't available.
 */
export function playBeep(type: "on" | "off"): void {
  try {
    const c = ctx();
    if (c.state === "suspended") {
      c.resume().catch(() => {});
    }
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = type === "on" ? 880 : 440;
    const now = c.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  } catch (e) {
    console.warn("[beep] Failed to play beep:", e);
  }
}
