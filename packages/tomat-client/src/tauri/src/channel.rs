// Install channel — keeps the client's on-disk state and OS-keychain
// entries isolated per channel, mirroring tomat-core's TOMAT_CHANNEL.
//
// Every channel (including stable) lives under ~/.tomat/<channel>/, so a
// dev or beta build never reads or clobbers a stable install's data:
//
//   stable → ~/.tomat/stable/{core,client}   keychain "tomat-client"
//   dev    → ~/.tomat/dev/{core,client}       keychain "tomat-client-dev"
//   beta   → ~/.tomat/beta/{core,client}      keychain "tomat-client-beta"
//
// Resolution order: the runtime TOMAT_CHANNEL env var (set by
// `deno task dev`) wins, then a value baked in at build time via
// `option_env!` (how a shipped beta bundle pins its channel), else
// "stable". Unknown values fall back to "stable" rather than crash the UI.
//
// Models are deliberately NOT channel-scoped on the core side; they live at
// the shared ~/.tomat/models. The client never touches the models dir, so
// nothing here needs to special-case it.

use std::path::{Path, PathBuf};

/// Map a raw channel string (env / build-time) to one of the known channels,
/// defaulting unknown / empty / missing values to "stable". Pure so it can be
/// unit-tested without touching the process environment.
fn normalize(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some("dev") => "dev",
        Some("beta") => "beta",
        _ => "stable",
    }
}

/// The active channel: one of "stable", "dev", "beta".
pub fn channel() -> &'static str {
    let from_env = std::env::var("TOMAT_CHANNEL").ok();
    normalize(from_env.as_deref().or(option_env!("TOMAT_CHANNEL")))
}

fn channel_root_for(home: &Path, channel: &str) -> PathBuf {
    home.join(".tomat").join(channel)
}

/// `~/.tomat/<channel>` — the per-channel root for core + client state.
pub fn channel_root(home: &Path) -> PathBuf {
    channel_root_for(home, channel())
}

fn keychain_service_for(channel: &str) -> String {
    if channel == "stable" {
        "tomat-client".to_string()
    } else {
        format!("tomat-client-{channel}")
    }
}

/// OS-keychain service name, namespaced per channel. Stable keeps the bare
/// "tomat-client" so existing entries keep resolving.
pub fn keychain_service() -> String {
    keychain_service_for(channel())
}

/// Suffix that namespaces per-channel binaries + OS service labels. Stable is
/// bare; dev/beta get "-dev"/"-beta". Mirrors core paths.ts channelSuffix().
fn channel_suffix_for(channel: &str) -> &'static str {
    match channel {
        "dev" => "-dev",
        "beta" => "-beta",
        _ => "",
    }
}

fn channel_port_offset(channel: &str) -> u16 {
    match channel {
        "beta" => 10,
        "dev" => 20,
        _ => 0,
    }
}

fn core_port_for(channel: &str) -> u16 {
    7800 + channel_port_offset(channel)
}

/// Default local-core HTTP port for this channel. Stable 7800; dev/beta are
/// offset so both cores can run as services at once. Mirrors core paths.ts
/// corePort().
pub fn core_port() -> u16 {
    core_port_for(channel())
}

/// Default local llama-server / whisper-server ports for this channel, offset
/// in lockstep with the core port. Mirror core paths.ts llmPort()/sttPort().
/// The UI uses these as fallbacks when the paired core hasn't overridden
/// llm.port / stt.port, so a beta client tokenizes against the beta llama
/// (7711) instead of stable's 7701.
pub fn llm_port() -> u16 {
    7701 + channel_port_offset(channel())
}

pub fn stt_port() -> u16 {
    7702 + channel_port_offset(channel())
}

fn core_binary_name_for(channel: &str, windows: bool) -> String {
    let suffix = channel_suffix_for(channel);
    if windows {
        format!("tomat-core{suffix}.exe")
    } else {
        format!("tomat-core{suffix}")
    }
}

/// On-disk filename of the locally-installed core binary for this channel
/// (tomat-core / tomat-core-beta, plus .exe on Windows). Mirrors core
/// paths.ts channelBinName("tomat-core").
pub fn core_binary_name() -> String {
    core_binary_name_for(channel(), cfg!(windows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn normalize_maps_known_channels_and_defaults_to_stable() {
        assert_eq!(normalize(None), "stable");
        assert_eq!(normalize(Some("")), "stable");
        assert_eq!(normalize(Some("stable")), "stable");
        assert_eq!(normalize(Some("dev")), "dev");
        assert_eq!(normalize(Some("beta")), "beta");
        assert_eq!(normalize(Some("  dev  ")), "dev"); // trims whitespace
        assert_eq!(normalize(Some("nonsense")), "stable"); // unknown → stable
    }

    #[test]
    fn channel_root_nests_under_dot_tomat() {
        let home = PathBuf::from("/home/u");
        assert_eq!(
            channel_root_for(&home, "stable"),
            PathBuf::from("/home/u/.tomat/stable")
        );
        assert_eq!(
            channel_root_for(&home, "dev"),
            PathBuf::from("/home/u/.tomat/dev")
        );
        assert_eq!(
            channel_root_for(&home, "beta"),
            PathBuf::from("/home/u/.tomat/beta")
        );
    }

    #[test]
    fn keychain_service_is_bare_on_stable_and_suffixed_otherwise() {
        assert_eq!(keychain_service_for("stable"), "tomat-client");
        assert_eq!(keychain_service_for("dev"), "tomat-client-dev");
        assert_eq!(keychain_service_for("beta"), "tomat-client-beta");
    }

    #[test]
    fn channel_suffix_is_bare_on_stable_and_suffixed_otherwise() {
        assert_eq!(channel_suffix_for("stable"), "");
        assert_eq!(channel_suffix_for("dev"), "-dev");
        assert_eq!(channel_suffix_for("beta"), "-beta");
    }

    #[test]
    fn core_port_offsets_per_channel() {
        assert_eq!(core_port_for("stable"), 7800);
        assert_eq!(core_port_for("beta"), 7810);
        assert_eq!(core_port_for("dev"), 7820);
    }

    #[test]
    fn core_binary_name_suffixes_per_channel() {
        assert_eq!(core_binary_name_for("stable", false), "tomat-core");
        assert_eq!(core_binary_name_for("beta", false), "tomat-core-beta");
        assert_eq!(core_binary_name_for("beta", true), "tomat-core-beta.exe");
        assert_eq!(core_binary_name_for("dev", false), "tomat-core-dev");
    }
}
