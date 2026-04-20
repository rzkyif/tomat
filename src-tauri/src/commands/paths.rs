//! Shared path-resolution and ID-validation helpers.
//!
//! Centralized here so session / snippet / toolkit storage all go through
//! the same sanitization, rather than duplicating rules across files.

use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};

/// Shared validator for on-disk entity IDs (session / snippet). Enforces a
/// safe subset that resolves to a single path component: alphanumeric, `-`,
/// or `_`, with bounded length.
pub fn validate_id(id: &str, kind: &str) -> AppResult<()> {
    if id.is_empty() || id.len() > 64 {
        return Err(AppError::validation(format!("Invalid {kind}")));
    }
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::validation(format!(
            "{kind} contains invalid characters"
        )));
    }
    Ok(())
}

pub fn validate_session_id(id: &str) -> AppResult<()> {
    validate_id(id, "session ID")
}

pub fn validate_snippet_id(id: &str) -> AppResult<()> {
    validate_id(id, "snippet ID")
}

/// Sanitize a user-supplied attachment filename. Rejects empty names,
/// strips any directory component, and blocks `..` and NUL.
pub fn sanitize_attachment_name(name: &str) -> AppResult<String> {
    if name.is_empty() || name.len() > 255 {
        return Err(AppError::validation("Invalid attachment filename"));
    }
    if name.contains('\0') || name == "." || name == ".." {
        return Err(AppError::validation("Invalid attachment filename"));
    }
    let stem = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::validation("Invalid attachment filename"))?;
    if stem.contains('/') || stem.contains('\\') {
        return Err(AppError::validation("Invalid attachment filename"));
    }
    Ok(stem.to_string())
}

/// Returns Some(canonical_path) if `path` resolves inside `root`, else None.
/// Both arguments are canonicalized to defeat symlink-based path traversal.
pub fn resolve_within(path: &Path, root_canonical: &Path) -> Option<PathBuf> {
    let p = path.canonicalize().ok()?;
    if p.starts_with(root_canonical) {
        Some(p)
    } else {
        None
    }
}
