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
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::ipc::{CmdError, TelemetryEvent, TELEMETRY_SCHEMA_VERSION};

pub struct TelemetrySink {
    dir: PathBuf,
    files: Mutex<HashMap<String, File>>,
    /// Opt-in state (P1-10.3, SPEC §15/§25). `true` writes normally; `false`
    /// makes every `log` a silent no-op. This is a defense-in-depth mirror of
    /// the webview producer's own consent guard (`TelemetryService`): the
    /// producer already suppresses emission when telemetry is off, and the
    /// sink honors the same flag so a stray envelope can never reach disk once
    /// the user has opted out. `AtomicBool` because the sink is shared behind a
    /// `&` via Tauri's `.manage()` (no `&mut` available to flip it).
    enabled: AtomicBool,
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
        Ok(Self { dir, files: Mutex::new(HashMap::new()), enabled: AtomicBool::new(true) })
    }

    /// Flip the opt-in state (P1-10.3). `false` makes every subsequent `log`
    /// a no-op until re-enabled; `true` (the default) writes normally. Wired
    /// to the webview consent toggle in a later ticket — for now the webview
    /// producer is the primary guard and this is its sink-side mirror.
    #[allow(dead_code)] // driven by the P1-10.3 consent toggle wiring in a later ticket; exercised by tests.
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    /// Appends one JSON line. Rejects (rather than best-effort-writing) an
    /// event with a missing/unsupported `schema_version` or missing
    /// `session_id` — a loud failure here is more useful than a quietly
    /// malformed JSONL file the H1 scoring sheet (P0-06.2) has to special-case.
    pub fn log(&self, event: &TelemetryEvent) -> Result<(), CmdError> {
        // Opt-in guard (P1-10.3, SPEC §15/§25): when telemetry is switched off,
        // nothing reaches disk — not even a validation failure. A no-op `Ok`
        // keeps `telemetry_log` infallible for the caller.
        if !self.enabled.load(Ordering::Relaxed) {
            return Ok(());
        }

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    impl TelemetrySink {
        /// Test-only constructor that skips the `AppHandle`/`app_data_dir`
        /// resolution `new` does — points the sink at a caller-owned dir so the
        /// JSONL side effect is observable without a Tauri runtime.
        fn with_dir(dir: PathBuf) -> Self {
            Self { dir, files: Mutex::new(HashMap::new()), enabled: AtomicBool::new(true) }
        }
    }

    /// A fresh, unique temp dir per test (no `tempfile` dev-dep in this crate).
    fn scratch_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir()
            .join(format!("hydropark-telemetry-test-{}-{nanos}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn base(session_id: &str) -> serde_json::Value {
        json!({
            "schema_version": TELEMETRY_SCHEMA_VERSION,
            "session_id": session_id,
            "ts_ms": 1_700_000_000_000u64,
        })
    }

    /// Merge the shared envelope base with a per-event body — mirrors the
    /// webview's `{ ...this.base(), ... }` spread in telemetry.service.ts.
    fn event(session_id: &str, body: serde_json::Value) -> serde_json::Value {
        let mut ev = base(session_id);
        let obj = ev.as_object_mut().unwrap();
        for (k, v) in body.as_object().unwrap() {
            obj.insert(k.clone(), v.clone());
        }
        ev
    }

    fn read_lines(dir: &PathBuf, session_id: &str) -> Vec<serde_json::Value> {
        let path = dir.join(format!("session-{session_id}.jsonl"));
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .collect()
    }

    /// The four P1-25.1 product-metric envelopes round-trip through the sink:
    /// each is written as its own JSONL line and reparses with the expected
    /// `event` discriminator and anonymized (bool/count only) payload.
    #[test]
    fn product_metric_events_serialize_and_persist() {
        let dir = scratch_dir();
        let sink = TelemetrySink::with_dir(dir.clone());
        let sid = "sess-metrics";

        let events = vec![
            event(sid, json!({ "event": "activation", "skill_id": "kitchen-timer", "first_session": true })),
            event(sid, json!({ "event": "composition", "skills_active": 2, "via_template": false })),
            event(sid, json!({ "event": "offline_usage", "offline": true, "backend_calls": 0 })),
            event(sid, json!({ "event": "crash_free_session", "crash_free": true, "errors": 0 })),
        ];
        for e in &events {
            sink.log(e).expect("enabled sink writes each metric envelope");
        }

        let lines = read_lines(&dir, sid);
        assert_eq!(lines.len(), 4, "one JSONL line per metric event");

        let names: Vec<&str> = lines.iter().map(|l| l["event"].as_str().unwrap()).collect();
        assert_eq!(names, ["activation", "composition", "offline_usage", "crash_free_session"]);

        // Payloads are anonymized: only enums/bools/counts, never free text.
        assert_eq!(lines[0]["skill_id"], "kitchen-timer");
        assert_eq!(lines[0]["first_session"], true);
        assert_eq!(lines[1]["skills_active"], 2);
        assert_eq!(lines[1]["via_template"], false);
        assert_eq!(lines[2]["offline"], true);
        assert_eq!(lines[2]["backend_calls"], 0);
        assert_eq!(lines[3]["crash_free"], true);
        assert_eq!(lines[3]["errors"], 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Opt-in guard (P1-10.3): with telemetry off, `log` is a no-op that writes
    /// nothing — not even the session file is created — and still returns `Ok`.
    #[test]
    fn opt_in_guard_suppresses_emission() {
        let dir = scratch_dir();
        let sink = TelemetrySink::with_dir(dir.clone());
        let sid = "sess-optout";
        sink.set_enabled(false);

        sink.log(&event(sid, json!({ "event": "activation", "skill_id": "kitchen-timer", "first_session": true })))
            .expect("a disabled sink logs a silent Ok, never an error");

        let path = dir.join(format!("session-{sid}.jsonl"));
        assert!(!path.exists(), "opted-out telemetry must never touch disk");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Re-enabling after an opt-out resumes writes (the guard is not one-way).
    #[test]
    fn re_enabling_resumes_emission() {
        let dir = scratch_dir();
        let sink = TelemetrySink::with_dir(dir.clone());
        let sid = "sess-resume";

        sink.set_enabled(false);
        sink.log(&event(sid, json!({ "event": "composition", "skills_active": 3, "via_template": true })))
            .unwrap();
        assert!(!dir.join(format!("session-{sid}.jsonl")).exists());

        sink.set_enabled(true);
        sink.log(&event(sid, json!({ "event": "composition", "skills_active": 3, "via_template": true })))
            .unwrap();
        let lines = read_lines(&dir, sid);
        assert_eq!(lines.len(), 1, "only the post-re-enable event is written");
        assert_eq!(lines[0]["via_template"], true);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
