// Resident HTTP speech sidecar for tomat-core.
//
// One self-contained binary (statically-linked sherpa-onnx) that serves Whisper
// speech-to-text and Kokoro text-to-speech over a small loopback HTTP API. It
// replaces the whisper-server sidecar and the kokoro-js TTS worker.
//
// A SINGLE instance holds each engine in a slot that can be loaded or dropped at
// runtime via `POST /configure`. Dropping an engine runs sherpa's C destructor,
// freeing that model's memory -- so disabling TTS (or STT) frees its model while
// the other stays resident, with no process restart. The core only stops the
// whole process when both modules are off. This preserves the per-module
// unload-on-disable memory behaviour the separate whisper-server / tts-worker had.
//
// Endpoints:
//   GET  /health      -> "ok" (process up; engines load eagerly from start flags).
//   POST /configure    -> body {stt:{...}|null, tts:{...}|null}: the full desired
//                         state. Each engine is (re)loaded when paths change and
//                         dropped when null. Idempotent.
//   POST /transcribe  -> body is WAV bytes; returns {"text": "..."} (503 if no STT).
//   POST /speak       -> JSON {text, voice|sid, speed}; returns audio/wav (503 if no TTS).

use std::env;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread;

use sherpa_onnx::{
    GeneratedAudio, GenerationConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineTts,
    OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig,
    OfflineWhisperModelConfig, Wave,
};
use tempfile::NamedTempFile;

mod voices;

#[derive(Clone, PartialEq, serde::Deserialize)]
struct SttPaths {
    encoder: String,
    decoder: String,
    tokens: String,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Clone, PartialEq, serde::Deserialize)]
struct TtsPaths {
    model: String,
    voices: String,
    tokens: String,
    #[serde(rename = "espeakData")]
    espeak_data: String,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default, rename = "dictDir")]
    dict_dir: Option<String>,
    #[serde(default)]
    lexicon: Option<String>,
}

/// Full desired engine state. The core sends both fields every time; a null (or
/// absent) field means "unload that engine".
#[derive(serde::Deserialize)]
struct ConfigureReq {
    #[serde(default)]
    stt: Option<SttPaths>,
    #[serde(default)]
    tts: Option<TtsPaths>,
}

/// One engine and the paths it was loaded from (so reconfigure is a no-op when
/// unchanged and a reload when the paths differ).
struct Slot<P, E> {
    paths: Option<P>,
    engine: Option<E>,
}

impl<P, E> Slot<P, E> {
    fn empty() -> Self {
        Self {
            paths: None,
            engine: None,
        }
    }
}

struct State {
    stt: Mutex<Slot<SttPaths, OfflineRecognizer>>,
    tts: Mutex<Slot<TtsPaths, OfflineTts>>,
    threads: i32,
}

#[derive(serde::Deserialize)]
struct SpeakReq {
    text: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    sid: Option<i32>,
    #[serde(default = "default_speed")]
    speed: f32,
}

fn default_speed() -> f32 {
    1.0
}

#[derive(serde::Serialize)]
struct TextResp {
    text: String,
}

/// Lock a mutex, recovering a poisoned guard rather than panicking (`-D warnings`
/// forbids `.unwrap()`; a panic in a locked section cannot happen here).
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn flag(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn build_recognizer(p: &SttPaths, threads: i32) -> Result<OfflineRecognizer, String> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.whisper = OfflineWhisperModelConfig {
        encoder: Some(p.encoder.clone()),
        decoder: Some(p.decoder.clone()),
        // Absent language lets Whisper auto-detect per utterance.
        language: p.language.clone(),
        ..Default::default()
    };
    config.model_config.tokens = Some(p.tokens.clone());
    config.model_config.num_threads = threads.max(1);
    OfflineRecognizer::create(&config).ok_or_else(|| "failed to load whisper model".to_string())
}

fn build_tts(p: &TtsPaths, threads: i32) -> Result<OfflineTts, String> {
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: Some(p.model.clone()),
                voices: Some(p.voices.clone()),
                tokens: Some(p.tokens.clone()),
                // espeak-ng phonemizer data; multilingual Kokoro (v1.0+) also
                // needs `lang` (or a lexicon) to pick a frontend.
                data_dir: Some(p.espeak_data.clone()),
                lang: p.lang.clone(),
                dict_dir: p.dict_dir.clone(),
                lexicon: p.lexicon.clone(),
                ..Default::default()
            },
            num_threads: threads.max(1),
            ..Default::default()
        },
        ..Default::default()
    };
    OfflineTts::create(&config).ok_or_else(|| "failed to load kokoro model".to_string())
}

/// Reconcile the STT slot to `want`. Builds the replacement BEFORE dropping the
/// current engine, so a failed load (bad or unreadable model path) leaves the
/// working engine intact instead of tearing it down. Swapping the slot then
/// drops the old engine via sherpa's C destructor, freeing its model's memory.
fn set_stt(state: &State, want: Option<SttPaths>) -> Result<(), String> {
    let mut slot = lock(&state.stt);
    if slot.paths == want {
        return Ok(());
    }
    match want {
        Some(p) => {
            let engine = build_recognizer(&p, state.threads)?;
            slot.engine = Some(engine);
            slot.paths = Some(p);
            eprintln!("tomat-core-speech: STT loaded");
        }
        None => {
            slot.engine = None;
            slot.paths = None;
            eprintln!("tomat-core-speech: STT unloaded");
        }
    }
    Ok(())
}

fn set_tts(state: &State, want: Option<TtsPaths>) -> Result<(), String> {
    let mut slot = lock(&state.tts);
    if slot.paths == want {
        return Ok(());
    }
    match want {
        Some(p) => {
            // Build before swapping so a failed load keeps the current engine.
            let engine = build_tts(&p, state.threads)?;
            eprintln!(
                "tomat-core-speech: TTS loaded (sample_rate={}, speakers={})",
                engine.sample_rate(),
                engine.num_speakers()
            );
            slot.engine = Some(engine);
            slot.paths = Some(p);
        }
        None => {
            slot.engine = None;
            slot.paths = None;
            eprintln!("tomat-core-speech: TTS unloaded");
        }
    }
    Ok(())
}

// sherpa's `Wave::read` only decodes from a file path, so the request bytes go
// to a private temp file first. `NamedTempFile` picks an unpredictable name and
// creates it with O_EXCL (no symlink or predictable-path race), and the
// `TempPath` removes it on drop. The fd is closed (into_temp_path) before
// `Wave::read` reopens the path, so this is also safe on Windows.
fn transcribe(rec: &OfflineRecognizer, wav_bytes: &[u8]) -> Result<String, String> {
    let mut tmp = NamedTempFile::new().map_err(|e| format!("temp file: {e}"))?;
    tmp.write_all(wav_bytes)
        .map_err(|e| format!("write temp: {e}"))?;
    tmp.flush().map_err(|e| format!("flush temp: {e}"))?;
    let path = tmp.into_temp_path();
    let wave = Wave::read(&path.to_string_lossy());
    drop(path);
    let wave = wave.ok_or_else(|| "could not decode WAV input".to_string())?;
    let stream = rec.create_stream();
    stream.accept_waveform(wave.sample_rate(), wave.samples());
    rec.decode(&stream);
    Ok(stream.get_result().map(|r| r.text).unwrap_or_default())
}

fn synthesize(tts: &OfflineTts, req: &SpeakReq) -> Result<GeneratedAudio, String> {
    let sid = req
        .sid
        .or_else(|| req.voice.as_deref().map(voices::resolve_sid))
        .unwrap_or(0);
    let gen = GenerationConfig {
        sid,
        speed: if req.speed > 0.0 { req.speed } else { 1.0 },
        ..Default::default()
    };
    tts.generate_with_config(&req.text, &gen, None::<fn(&[f32], f32) -> bool>)
        .ok_or_else(|| "synthesis failed".to_string())
}

/// Encode mono f32 PCM samples as a 16-bit WAV byte buffer (canonical RIFF
/// layout, sample rate at byte offset 24). Builds the response in memory rather
/// than round-tripping through `GeneratedAudio::save` and a temp file.
fn wav_from_samples(samples: &[f32], sample_rate: i32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let sr = sample_rate.max(1) as u32;
    let mut buf = Vec::with_capacity(44 + data_len);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    buf.extend_from_slice(&1u16.to_le_bytes()); // format = PCM
    buf.extend_from_slice(&1u16.to_le_bytes()); // channels = mono
    buf.extend_from_slice(&sr.to_le_bytes());
    buf.extend_from_slice(&(sr * 2).to_le_bytes()); // byte rate (mono, 2 bytes/sample)
    buf.extend_from_slice(&2u16.to_le_bytes()); // block align
    buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&(data_len as u32).to_le_bytes());
    for &s in samples {
        buf.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    buf
}

fn respond_text(request: tiny_http::Request, code: u16, body: &str) {
    let _ = request.respond(tiny_http::Response::from_string(body).with_status_code(code));
}

fn respond_json(request: tiny_http::Request, code: u16, body: String) {
    match tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        Ok(h) => {
            let _ = request.respond(
                tiny_http::Response::from_string(body)
                    .with_status_code(code)
                    .with_header(h),
            );
        }
        Err(()) => respond_text(request, code, "header error"),
    }
}

fn handle(mut request: tiny_http::Request, state: &State) {
    let method = request.method().as_str().to_string();
    let path = request.url().split('?').next().unwrap_or("").to_string();

    match (method.as_str(), path.as_str()) {
        ("GET", "/health") => respond_text(request, 200, "ok"),
        ("POST", "/configure") => {
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                return respond_text(request, 400, "read error");
            }
            let req: ConfigureReq = match serde_json::from_str(&body) {
                Ok(r) => r,
                Err(e) => return respond_text(request, 400, &format!("bad json: {e}")),
            };
            if let Err(e) = set_stt(state, req.stt) {
                return respond_text(request, 500, &e);
            }
            if let Err(e) = set_tts(state, req.tts) {
                return respond_text(request, 500, &e);
            }
            respond_text(request, 200, "ok");
        }
        ("POST", "/transcribe") => {
            let mut body = Vec::new();
            if request.as_reader().read_to_end(&mut body).is_err() {
                return respond_text(request, 400, "read error");
            }
            let slot = lock(&state.stt);
            let Some(rec) = slot.engine.as_ref() else {
                return respond_text(request, 503, "stt not loaded");
            };
            match transcribe(rec, &body) {
                Ok(text) => {
                    let json = serde_json::to_string(&TextResp { text })
                        .unwrap_or_else(|_| "{\"text\":\"\"}".to_string());
                    respond_json(request, 200, json);
                }
                Err(e) => respond_text(request, 500, &e),
            }
        }
        ("POST", "/speak") => {
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                return respond_text(request, 400, "read error");
            }
            let req: SpeakReq = match serde_json::from_str(&body) {
                Ok(r) => r,
                Err(e) => return respond_text(request, 400, &format!("bad json: {e}")),
            };
            let slot = lock(&state.tts);
            let Some(tts) = slot.engine.as_ref() else {
                return respond_text(request, 503, "tts not loaded");
            };
            match synthesize(tts, &req) {
                Ok(audio) => {
                    let bytes = wav_from_samples(audio.samples(), audio.sample_rate());
                    match tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"audio/wav"[..]) {
                        Ok(h) => {
                            let _ = request
                                .respond(tiny_http::Response::from_data(bytes).with_header(h));
                        }
                        Err(()) => respond_text(request, 500, "header error"),
                    }
                }
                Err(e) => respond_text(request, 500, &e),
            }
        }
        _ => respond_text(request, 404, "not found"),
    }
}

/// Build the initial desired state from `--stt-*` / `--tts-*` flags so a freshly
/// started instance loads its models before serving (readiness == loaded). The
/// core may later change this at runtime via `/configure`.
fn initial_config(args: &[String]) -> ConfigureReq {
    let stt = match (
        flag(args, "--stt-encoder"),
        flag(args, "--stt-decoder"),
        flag(args, "--stt-tokens"),
    ) {
        (Some(encoder), Some(decoder), Some(tokens)) => Some(SttPaths {
            encoder,
            decoder,
            tokens,
            language: flag(args, "--stt-language"),
        }),
        _ => None,
    };
    let tts = match (
        flag(args, "--tts-model"),
        flag(args, "--tts-voices"),
        flag(args, "--tts-tokens"),
        flag(args, "--tts-espeak-data"),
    ) {
        (Some(model), Some(voices_path), Some(tokens), Some(espeak_data)) => Some(TtsPaths {
            model,
            voices: voices_path,
            tokens,
            espeak_data,
            lang: flag(args, "--tts-lang"),
            dict_dir: flag(args, "--tts-dict-dir"),
            lexicon: flag(args, "--tts-lexicon"),
        }),
        _ => None,
    };
    ConfigureReq { stt, tts }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    let host = flag(&args, "--host").unwrap_or_else(|| "127.0.0.1".to_string());
    let port: u16 = flag(&args, "--port")
        .and_then(|s| s.parse().ok())
        .unwrap_or(7702);
    let threads: i32 = flag(&args, "--threads")
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            thread::available_parallelism()
                .map(|n| n.get() as i32)
                .unwrap_or(4)
                .min(4)
        });

    let state = Arc::new(State {
        stt: Mutex::new(Slot::empty()),
        tts: Mutex::new(Slot::empty()),
        threads,
    });

    let initial = initial_config(&args);
    set_stt(&state, initial.stt)?;
    set_tts(&state, initial.tts)?;

    let server = tiny_http::Server::http((host.as_str(), port))
        .map_err(|e| format!("bind {host}:{port}: {e}"))?;
    let server = Arc::new(server);
    eprintln!("tomat-core-speech: listening on {host}:{port}");

    let n_workers = (threads as usize).clamp(1, 4);
    let mut handles = Vec::new();
    for _ in 0..n_workers {
        let server = Arc::clone(&server);
        let state = Arc::clone(&state);
        handles.push(thread::spawn(move || {
            while let Ok(request) = server.recv() {
                handle(request, &state);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("tomat-core-speech: {e}");
        std::process::exit(1);
    }
}
