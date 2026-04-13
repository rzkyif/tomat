import { browser } from "$app/environment";
import { invoke } from "@tauri-apps/api/core";
import { loadTtsModel, synthesizeTts, unloadTtsModel } from "$lib/sidecar/tts";
import { TTS_BASE_FILES } from "$lib/shared/settings";
import { stripMarkdownForTTS } from "$lib/shared/text";
import { serversState } from "./servers.svelte";
import { settingsState } from "./settings.svelte";

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });
function countWords(text: string): number {
  let n = 0;
  for (const seg of WORD_SEGMENTER.segment(text)) {
    if (seg.isWordLike) n++;
  }
  return n;
}

const SENTENCE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "sentence" });

// One audio chunk in the playback queue. Holds the element, its owning blob
// URL (so we can revoke it after playback/reset), and the pre-measured
// effective duration (native duration adjusted for the element's playbackRate
// at scheduling time). Duration is captured up-front so the batcher's
// deadline estimator doesn't need to poll `audio.duration` at runtime.
type PlaybackEntry = {
  audio: HTMLAudioElement;
  url: string;
  effectiveDurationMs: number;
  /** Captured at schedule time and re-applied right before `play()` - some
   *  browsers reset the element's `playbackRate` to 1 when the source
   *  finishes loading, so assigning it earlier is effectively ignored. */
  playbackRate: number;
};

/** Split a pending blob into `head` (up to maxWords) and `tail` (remainder).
 *  Breaks on sentence boundaries so prosody stays clean. If the very first
 *  sentence already exceeds maxWords, it's taken whole - we'd rather send
 *  one oversized chunk than lose the sentence. */
function splitAtMaxWords(
  text: string,
  maxWords: number,
): { head: string; tail: string; headWords: number; tailWords: number } {
  const sentences = Array.from(SENTENCE_SEGMENTER.segment(text));
  let head = "";
  let headWords = 0;
  let i = 0;
  for (; i < sentences.length; i++) {
    const s = sentences[i].segment;
    const w = countWords(s);
    if (head && headWords + w > maxWords) break;
    head += s;
    headWords += w;
  }
  if (!head && sentences.length > 0) {
    head = sentences[0].segment;
    headWords = countWords(head);
    i = 1;
  }
  let tail = "";
  for (; i < sentences.length; i++) tail += sentences[i].segment;
  const tailWords = countWords(tail);
  return { head, tail, headWords, tailWords };
}

// Smart-batching parameters. Kokoro is most efficient at ~100-200 tokens
// per request, which is roughly 25-50 words. We try to grow each chunk
// (after the first) up to MAX_WORDS, but never let a gap form between
// playback segments.
const MAX_WORDS = 50;
// Safety margin so we don't dispatch right when audio ends and risk a tiny
// gap from network/decode jitter.
const SAFETY_MS = 250;
// Floor for the re-check timer so we don't spin.
const MIN_RECHECK_MS = 75;

class TTSState {
  enabled = $state(false);
  loaded = $state(false);
  loading = $state(false);
  /** ID of the message TTS is currently voicing (streaming or replay).
   *  Cleared when playback fully drains or reset() is called. */
  currentMessageId = $state<string | null>(null);
  /** Number of audio sources currently queued/playing. Mirror of
   *  `liveSources.size`, exposed so components can react to "is audio
   *  actually coming out right now?" vs. "are we still synthesizing?". */
  liveSourceCount = $state(0);
  /** True while a /api/tts/synthesize request is in flight. Used with
   *  `liveSourceCount` to tell "loading" from "playing" in the UI. */
  synthInflight = $state(false);

  // Sentence-level pending buffer. Anything in here is text the streaming
  // detector has handed us but that hasn't been sent to /api/tts/synthesize.
  private pending = "";
  private pendingWords = 0;
  private streamFinalized = false;

  // We allow at most one in-flight synthesis at a time so that any text the
  // detector hands us while we wait can be batched into the next request.
  private inflight: Promise<void> | null = null;

  // HTMLAudioElement-based playback. We use the media element (rather than
  // an AudioBufferSourceNode) because `preservesPitch` lets us run
  // `tts.playbackSpeed` without chipmunking the voice. The trade-off is
  // coarser scheduling - chunks are chained via `onended` instead of at
  // the AudioContext sample clock, so there's a tiny browser-level gap
  // (~20-60 ms) between chunks.
  private playbackQueue: PlaybackEntry[] = [];
  private currentEntry: PlaybackEntry | null = null;
  // Wall-clock timestamp (performance.now ms) at which the current audio
  // started playing - used to compute remaining time for the batcher.
  private currentStartedAt = 0;

  // Learned synthesis cost in ms per word (EMA over observed chunks). Used
  // to predict how long the pending buffer will take to synthesize so we
  // can schedule dispatch to land exactly when the current playback ends.
  private msPerWord: number | null = null;

  // Re-check timer used while we're holding a pending batch back, waiting
  // for the playing chunk to wind down before dispatching the next one.
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;

  // Every reset() bumps this. Each dispatch captures the current value; when
  // its synthesis resolves it compares against the epoch to detect "a reset
  // happened while I was in flight" - in that case the result is discarded
  // instead of being scheduled for playback.
  private resetEpoch = 0;

  async setEnabled(enabled: boolean): Promise<void> {
    if (!browser) return;
    this.enabled = enabled;
    if (enabled) {
      if (this.loaded || this.loading) return;
      this.loading = true;
      try {
        await invoke("ensure_models", {
          server: "bun",
          paths: [...TTS_BASE_FILES],
        });
        await loadTtsModel();
        this.loaded = true;
        serversState.updateStatus({ server: "bun", status: "Running" });
      } catch (e) {
        console.error("[tts] load failed:", e);
        this.loaded = false;
        serversState.updateStatus({
          server: "bun",
          status: "Error",
          message: `TTS load failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        this.loading = false;
      }
    } else {
      this.reset();
      this.loaded = false;
      await unloadTtsModel();
    }
  }

  /** Reset any current playback / queue and claim the TTS pipeline for a new
   *  message. Keeps the learned msPerWord estimate across streams. */
  startStream(messageId: string | null = null): void {
    this.reset();
    this.currentMessageId = messageId;
  }

  /** Play an already-complete message's content through the batcher.
   *  Stops any current playback and clears the queue first. */
  replayMessage(messageId: string, content: string): void {
    if (!this.enabled || !this.loaded) return;
    this.reset();
    this.currentMessageId = messageId;
    const stripped = stripMarkdownForTTS(content);
    if (!stripped) {
      this.currentMessageId = null;
      return;
    }
    const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
    for (const s of seg.segment(stripped)) {
      const chunk = s.segment.trim();
      if (chunk) this.feedSentence(chunk);
    }
    this.finalize();
  }

  /** Hand a completed (or near-completed on finalize) sentence to the batcher. */
  feedSentence(text: string): void {
    if (!this.enabled || !this.loaded) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.pending += this.pending ? " " + trimmed : trimmed;
    this.pendingWords += countWords(trimmed);
    this.maybeDispatch();
  }

  /** Mark stream as ended; flush whatever's still pending. */
  finalize(): void {
    if (!this.enabled || !this.loaded) return;
    this.streamFinalized = true;
    this.maybeDispatch();
  }

  private maybeDispatch(): void {
    if (this.inflight) return;
    if (this.pendingWords === 0) return;

    const settings = settingsState.currentSettings;
    const minWords = Math.max(1, Number(settings["tts.minChunkWords"]) || 8);

    let dispatch = false;
    let recheckIn = 0;

    if (this.streamFinalized) {
      // Stream done, no more text incoming - flush whatever we have.
      dispatch = true;
    } else if (this.pendingWords >= MAX_WORDS) {
      dispatch = true;
    } else {
      const playbackEndsInMs = this.playbackRemainingMs();
      if (playbackEndsInMs <= 0) {
        // First chunk of the stream (or playback already drained while we
        // waited for more text). Apply the low-latency rule from the user
        // setting so the first word reaches the listener fast.
        if (this.pendingWords >= minWords) dispatch = true;
      } else if (this.msPerWord !== null) {
        // We have an estimate. Dispatch when remaining playback time has
        // shrunk to "estimated synth time + safety". This lets the chunk
        // grow as long as possible while guaranteeing the result lands
        // before the speaker stops.
        const estProcessingMs = this.pendingWords * this.msPerWord + SAFETY_MS;
        if (playbackEndsInMs <= estProcessingMs) {
          dispatch = true;
        } else {
          recheckIn = playbackEndsInMs - estProcessingMs;
        }
      } else {
        // We haven't observed a synthesis yet but something is already
        // playing. Fall back to the min-words rule so we don't sit on text.
        if (this.pendingWords >= minWords) dispatch = true;
      }
    }

    if (dispatch) {
      this.dispatch();
    } else if (recheckIn > 0) {
      this.scheduleRecheck(recheckIn);
    }
  }

  private playbackRemainingMs(): number {
    let total = 0;
    if (this.currentEntry) {
      const elapsed = performance.now() - this.currentStartedAt;
      total += Math.max(0, this.currentEntry.effectiveDurationMs - elapsed);
    }
    for (const entry of this.playbackQueue) total += entry.effectiveDurationMs;
    return total;
  }

  private scheduleRecheck(delayMs: number): void {
    // Always reschedule with the freshest deadline. Each `feedSentence` grows
    // the pending buffer, which raises the estimated synth time and brings
    // the dispatch deadline closer; the previous timer would otherwise fire
    // late.
    if (this.recheckTimer != null) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(
      () => {
        this.recheckTimer = null;
        this.maybeDispatch();
      },
      Math.max(MIN_RECHECK_MS, delayMs),
    );
  }

  private dispatch(): void {
    // Consume only up to MAX_WORDS of pending. Kokoro's tokenizer truncates
    // input beyond ~510 tokens, so if we shipped the entire buffer on a long
    // replay we'd silently drop the tail of the message. Any remaining text
    // stays in `pending` and the next `maybeDispatch` picks it up.
    const { head, tail, headWords, tailWords } = splitAtMaxWords(this.pending, MAX_WORDS);
    const text = head;
    const words = headWords;
    this.pending = tail;
    this.pendingWords = tailWords;
    if (this.recheckTimer != null) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }

    const settings = settingsState.currentSettings;
    const voice = (settings["tts.voice"] as string) || "af_bella";
    // Synthesis speed is baked into the WAV Kokoro returns (shorter audio
    // for higher values, normal pitch). Playback speed is applied on the
    // AudioBufferSourceNode after decode (same pitch-shifted speed-up as
    // HTML5 `<audio>` playback rate). See scheduleAudio.
    const synthSpeed = Math.max(0.25, Math.min(3, Number(settings["tts.synthesisSpeed"]) || 1));

    const epochAtDispatch = this.resetEpoch;
    const t0 = performance.now();
    this.synthInflight = true;
    const synthPromise = synthesizeTts(text, voice, synthSpeed);

    this.inflight = (async () => {
      let wav: ArrayBuffer | null = null;
      try {
        wav = await synthPromise;
      } catch (e) {
        console.warn("[tts] synth failed:", e);
      }
      // If reset() fired while this synth was in flight, drop the result -
      // otherwise the user hears a chunk of audio pop in after they hit stop.
      if (epochAtDispatch !== this.resetEpoch) {
        this.inflight = null;
        this.synthInflight = false;
        return;
      }
      if (wav && wav.byteLength > 0) {
        // Update the learned synth cost. Slight bias toward the latest
        // observation so the estimate tracks model warm-up / cool-down.
        const synthMs = performance.now() - t0;
        const observed = synthMs / Math.max(1, words);
        this.msPerWord = this.msPerWord === null ? observed : this.msPerWord * 0.4 + observed * 0.6;

        try {
          await this.scheduleAudio(wav);
        } catch (e) {
          console.warn("[tts] decode/play failed:", e);
        }
      }
      this.inflight = null;
      this.synthInflight = false;
      // After dispatching, more text may have accumulated - re-evaluate.
      this.maybeDispatch();
    })();
  }

  private async scheduleAudio(wav: ArrayBuffer): Promise<void> {
    const playbackRate = Math.max(
      0.25,
      Math.min(3, Number(settingsState.currentSettings["tts.playbackSpeed"]) || 1),
    );
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = url;

    // Wait for metadata so `audio.duration` is defined before we compute
    // the effective length.
    try {
      await new Promise<void>((resolve, reject) => {
        const onLoad = () => {
          audio.removeEventListener("loadedmetadata", onLoad);
          audio.removeEventListener("error", onErr);
          resolve();
        };
        const onErr = () => {
          audio.removeEventListener("loadedmetadata", onLoad);
          audio.removeEventListener("error", onErr);
          reject(new Error("audio metadata load failed"));
        };
        audio.addEventListener("loadedmetadata", onLoad);
        audio.addEventListener("error", onErr);
      });
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }

    const effectiveDurationMs =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? (audio.duration / playbackRate) * 1000
        : 0;

    const entry: PlaybackEntry = { audio, url, effectiveDurationMs, playbackRate };
    audio.onended = () => this.onEntryEnded(entry);
    audio.onerror = () => this.onEntryEnded(entry);

    if (this.currentEntry) {
      // Something's already playing - queue this one for its turn.
      this.playbackQueue.push(entry);
    } else {
      // Nothing playing - start immediately.
      this.startEntry(entry);
    }
  }

  private startEntry(entry: PlaybackEntry): void {
    this.currentEntry = entry;
    this.currentStartedAt = performance.now();
    this.liveSourceCount = 1;
    // Apply preservesPitch + playbackRate right before play(). Some browsers
    // reset the element's playbackRate back to 1 when the source finishes
    // loading, so setting it earlier (e.g. right after `new Audio()`) gets
    // quietly ignored by the time the media is ready.
    const a = entry.audio as HTMLAudioElement & { preservesPitch?: boolean };
    a.preservesPitch = true;
    a.playbackRate = entry.playbackRate;
    entry.audio.play().catch((e) => {
      console.warn("[tts] play failed:", e);
      this.onEntryEnded(entry);
    });
  }

  private onEntryEnded(entry: PlaybackEntry): void {
    // Tear down this entry (even if it's mid-queue and got cancelled by
    // reset - in that case currentEntry/playbackQueue will already be
    // cleared, so we just free its URL).
    URL.revokeObjectURL(entry.url);
    entry.audio.onended = null;
    entry.audio.onerror = null;
    if (this.currentEntry !== entry) return;

    this.currentEntry = null;
    const next = this.playbackQueue.shift();
    if (next) {
      this.startEntry(next);
    } else {
      this.liveSourceCount = 0;
      if (!this.inflight && this.pendingWords === 0) {
        this.currentMessageId = null;
      }
    }
    this.maybeDispatch();
  }

  /** Stop any current playback and clear pending state. Keeps msPerWord. */
  reset(): void {
    this.resetEpoch++;
    if (this.recheckTimer != null) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
    this.pending = "";
    this.pendingWords = 0;
    this.streamFinalized = false;
    this.currentMessageId = null;

    const entries: PlaybackEntry[] = [];
    if (this.currentEntry) entries.push(this.currentEntry);
    entries.push(...this.playbackQueue);
    this.currentEntry = null;
    this.playbackQueue = [];
    for (const e of entries) {
      try {
        e.audio.onended = null;
        e.audio.onerror = null;
        e.audio.pause();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(e.url);
    }

    this.liveSourceCount = 0;
    this.synthInflight = false;
  }
}

export const ttsState = new TTSState();
