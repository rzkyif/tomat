use serde::Deserialize;

// Window alignment for `position_window`. Sidecar / server status types have
// moved to tomat-core (returned over HTTP); the client no longer mirrors them.
#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum WindowAlignment {
    Left,
    Center,
    Right,
}
