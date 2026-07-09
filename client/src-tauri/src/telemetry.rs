//! The JSONL session-event sink (P0-06.1). Rust owns the filesystem
//! (`client/IPC-CONTRACT.md`'s responsibility split) — the webview only
//! ever sends a fully-formed telemetry envelope over `telemetry_log`; it
//! never writes to disk itself.
//!
//! One file per session: `<app-data-dir>/logs/session-<session_id>.jsonl`,
//! append-only, one JSON object per line. Schema is deliberately loose on
//! this side (`serde_json::Value`, see `ipc.rs::TelemetryEvent`) — the only
//! thing enforced here is that `schema_version` matches
//! `TELEMETRY_SCHEMA_VERSION` (P0-06.2: "versioned so a late schema change
//! doesn't invalidate earlier sessions" — a version mismatch is rejected
//! loudly rather than silently written and later misread).

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::ipc::{CmdError, TelemetryEvent, TELEMETRY_SCHEMA_VERSION};

pub struct TelemetrySink {
    dir: PathBuf,
    files: Mutex<HashMap<String, File>>,
}

impl TelemetrySink {
    /// Resolves `<app-data-dir>/logs` and ensures it exists. Called once
    /// from `main.rs`'s `.setup()` and registered via `.manage()`.
    pub fn new(app: &AppHandle) -> Result<Self, CmdError> {
        let base = app
            .path()
            .app_data_dir()
            .map_err(|e| CmdError::Io(e.to_string()))?;
        let dir = base.join("logs");
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir, files: Mutex::new(HashMap::new()) })
    }

    /// Appends one JSON line. Rejects (rather than best-effort-writing) an
    /// event with a missing/unsupported `schema_version` or missing
    /// `session_id` — a loud failure here is more useful than a quietly
    /// malformed JSONL file the H1 scoring sheet (P0-06.2) has to special-case.
    pub fn log(&self, event: &TelemetryEvent) -> Result<(), CmdError> {
        let session_id = event
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CmdError::InvalidArgs("telemetry event missing session_id".into()))?
            .to_string();

        let schema_version = event.get("schema_version").and_then(|v| v.as_u64());
        if schema_version != Some(u64::from(TELEMETRY_SCHEMA_VERSION)) {
            return Err(CmdError::InvalidArgs(format!(
                "unsupported telemetry schema_version: {schema_version:?} (expected {TELEMETRY_SCHEMA_VERSION})"
            )));
        }

        let mut files = self.files.lock().expect("telemetry sink mutex poisoned");
        let file = match files.entry(session_id.clone()) {
            Entry::Occupied(e) => e.into_mut(),
            Entry::Vacant(e) => {
                let path = self.dir.join(format!("session-{session_id}.jsonl"));
                let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
                e.insert(file)
            }
        };

        let line = serde_json::to_string(event).map_err(|e| CmdError::Io(e.to_string()))?;
        writeln!(file, "{line}")?;
        Ok(())
    }
}
