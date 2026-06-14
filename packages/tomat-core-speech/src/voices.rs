//! Maps tomat's named Kokoro voices (e.g. "af_bella") to sherpa speaker ids for
//! the bundled `kokoro-int8-multi-lang-v1_0` model.
//!
//! The order below is authoritative: it mirrors sherpa-onnx's
//! `scripts/kokoro/v1.0/generate_voices_bin.py`, which writes the speaker style
//! vectors to voices.bin in exactly this order, so index == sherpa sid. It also
//! matches the `tts.voice` enum in the shared settings schema one-for-one.

/// Resolve a voice selector to a sherpa speaker id. Accepts a numeric id passed
/// as a string, or a known voice name; falls back to speaker 0.
pub fn resolve_sid(voice: &str) -> i32 {
    if let Ok(n) = voice.parse::<i32>() {
        return n;
    }
    VOICES
        .iter()
        .position(|name| *name == voice)
        .map(|i| i as i32)
        .unwrap_or(0)
}

/// Speaker names in voices.bin order (index == sherpa sid).
static VOICES: &[&str] = &[
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_heart",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
    "ef_dora",
    "em_alex",
    "ff_siwis",
    "hf_alpha",
    "hf_beta",
    "hm_omega",
    "hm_psi",
    "if_sara",
    "im_nicola",
    "jf_alpha",
    "jf_gongitsune",
    "jf_nezumi",
    "jf_tebukuro",
    "jm_kumo",
    "pf_dora",
    "pm_alex",
    "pm_santa",
    "zf_xiaobei",
    "zf_xiaoni",
    "zf_xiaoxiao",
    "zf_xiaoyi",
    "zm_yunjian",
    "zm_yunxi",
    "zm_yunxia",
    "zm_yunyang",
];
