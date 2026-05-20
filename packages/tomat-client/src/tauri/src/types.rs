use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum ServerStatus {
    Disabled,
    Error,
    Loading,
    Running,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerStatusUpdate {
    pub server: String,
    pub status: ServerStatus,
    pub progress: Option<f64>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum WindowAlignment {
    Left,
    Center,
    Right,
}
