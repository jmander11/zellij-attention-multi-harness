use std::io::Write;
use std::time::SystemTime;

use serde::Deserialize;

use crate::state::NotificationType;

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct RadarPayload {
    pub pane: RadarPane,
    pub status: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct RadarPane {
    pub id: u32,
}

/// Parse a zj_radar.status.v1 JSON payload.
/// Returns (pane_id, NotificationType) for pending/error/done.
/// Returns None for running/idle/unknown/parse-failure.
pub fn parse_radar_payload(raw: &str) -> Option<(u32, NotificationType)> {
    let payload: RadarPayload = match serde_json::from_str(raw) {
        Ok(p) => p,
        Err(e) => {
            log_error(&format!("radar parse error: {}", e));
            return None;
        }
    };

    let notification = match payload.status.as_str() {
        "pending" | "error" => NotificationType::Waiting,
        "done" => NotificationType::Completed,
        "running" | "idle" | _ => return None,
    };

    Some((payload.pane.id, notification))
}

fn log_error(msg: &str) {
    let path = "/tmp/zellij-attention.log";
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{} {}", ts, msg);
    } else {
        eprintln!("zellij-attention: {}", msg);
    }
}
