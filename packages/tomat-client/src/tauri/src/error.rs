use thiserror::Error;

/// Unified error type for Tauri commands and internal helpers.
///
/// Variants preserve the underlying source chain via `thiserror`, so callers
/// can use `?` on common error types (`std::io::Error`, `serde_json::Error`,
/// `reqwest::Error`, etc.) instead of stringifying them at each call site.
///
/// The wire format stays a plain string: `serde::Serialize` delegates to
/// `Display`, so the frontend sees the same error shape it did before.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("{0}")]
    Sidecar(String),

    #[error("{0}")]
    External(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Serde(#[from] serde_json::Error),

    #[error(transparent)]
    Tauri(#[from] tauri::Error),

    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),

    #[error(transparent)]
    Keyring(#[from] keyring::Error),

    #[error(transparent)]
    Base64(#[from] base64::DecodeError),

    #[error(transparent)]
    Url(#[from] url::ParseError),

    #[error(transparent)]
    Image(#[from] image::ImageError),

    #[error(transparent)]
    Semaphore(#[from] tokio::sync::AcquireError),
}

impl AppError {
    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }

    pub fn sidecar(msg: impl Into<String>) -> Self {
        AppError::Sidecar(msg.into())
    }

    pub fn external(msg: impl Into<String>) -> Self {
        AppError::External(msg.into())
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
