use crate::error::AppError;
use std::str::FromStr;

/// Typed sidecar identifier. Replaces the raw string identifiers (`"llm"`,
/// `"stt"`, `"bun"`) that used to float through sidecar lifecycle code, so
/// typos fail at compile time and `match` exhaustiveness is enforced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SidecarKind {
    Llm,
    Stt,
    Bun,
}

impl SidecarKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            SidecarKind::Llm => "llm",
            SidecarKind::Stt => "stt",
            SidecarKind::Bun => "bun",
        }
    }

    /// The tauri-plugin-shell sidecar binary name for this kind. Matches the
    /// `externalBin` entries in `tauri.conf.json`.
    pub const fn binary_name(self) -> &'static str {
        match self {
            SidecarKind::Llm => "tomat-llama-server",
            SidecarKind::Stt => "tomat-whisper-server",
            SidecarKind::Bun => "tomat-tools-server",
        }
    }
}

impl std::fmt::Display for SidecarKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SidecarKind {
    type Err = AppError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "llm" => Ok(Self::Llm),
            "stt" => Ok(Self::Stt),
            "bun" => Ok(Self::Bun),
            other => Err(AppError::validation(format!(
                "unknown sidecar kind: {other}"
            ))),
        }
    }
}
