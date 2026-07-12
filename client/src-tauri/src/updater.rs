#![allow(dead_code)] // The command is wired in main.rs; the classifier is unit-tested standalone.

//! App auto-update seam (P1-11.2, SPEC §18).
//!
//! `main.rs`'s `check_for_update` command asks `tauri-plugin-updater` whether a
//! newer *signed* build is published at the configured endpoint and reports the
//! typed [`UpdateCheckResult`] the webview's update surface renders ("Up to date"
//! / "Update available" / "Updating…").
//!
//! ## This is a GATE, not a finished feature
//! The update SERVER and the minisign SIGNING KEY are not yet provisioned. Until
//! they are, `tauri.conf.json` `plugins.updater` ships a clearly-marked
//! PLACEHOLDER `endpoints`/`pubkey` (see that file), so [`check`] here always
//! fails CLOSED — the app never auto-updates. The seam, the command, and the
//! client surface all compile and run now; wiring a real endpoint + key is the
//! only remaining step to make it live.
//!
//! ## Never breaks offline use (§18)
//! [`check`] is **infallible from the caller's view**: any failure — offline, an
//! unreachable endpoint, or the placeholder-gate config that can't build a valid
//! updater — is swallowed into [`UpdatePhase::Error`], never a rejected command.
//! An update check (e.g. one fired at launch) can therefore never block or crash
//! a fully-offline session.
//!
//! ## Testable seam
//! The plugin call needs a live `AppHandle` + network, so the decision logic is
//! split out into the pure [`classify`], which maps "what the endpoint reported"
//! (an [`Option<UpdateInfo>`]) to the typed status with no plugin and no network —
//! that is what the unit tests at the bottom drive.

use tauri::{AppHandle, Manager};

use crate::ipc::UpdateCheckResult;

/// The minimal facts pulled out of the updater plugin's `Update` — the available
/// version and its optional release notes. Kept separate from the plugin type so
/// [`classify`] is unit-testable with no plugin/network dependency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
}

/// Pure mapping from "what the endpoint reported" to the typed status the webview
/// renders: `Some(info)` ⇒ a newer signed build is available, `None` ⇒ up to date.
/// No `AppHandle`, no network — the seam the tests exercise.
pub fn classify(current_version: &str, available: Option<UpdateInfo>) -> UpdateCheckResult {
    match available {
        Some(info) => UpdateCheckResult::available(current_version, info.version, info.notes),
        None => UpdateCheckResult::up_to_date(current_version),
    }
}

/// Run a real check against the configured endpoint via the updater plugin and map
/// it to the typed status.
///
/// OFFLINE-SAFE (§18): this NEVER returns an error to the caller. A failed check
/// (offline, an unreachable endpoint, or the PLACEHOLDER pubkey/endpoint that ships
/// until the update server + signing key are provisioned — the release GATE)
/// resolves to [`UpdatePhase::Error`], so a checked-at-launch update can never block
/// or fail an offline session.
pub async fn check(app: &AppHandle) -> UpdateCheckResult {
    let current = app.package_info().version.to_string();
    match run_check(app).await {
        Ok(found) => classify(&current, found),
        Err(message) => UpdateCheckResult::error(current, message),
    }
}

/// The one spot that actually touches the plugin (and thus the network). Errors are
/// flattened to `String` here so the returned future stays `Send` (Tauri spawns
/// command futures on its async runtime) and so [`check`] can fold them into the
/// non-blocking `Error` status.
async fn run_check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    // Building the updater parses the configured pubkey/endpoints; the PLACEHOLDER
    // pubkey fails here (fail-closed) until a real key is provisioned.
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    // `u.version` is the available version. Release notes (the update manifest's
    // `body`/notes) are left `None` here and wired once the exact `Update` field name
    // is confirmed against the pinned `tauri-plugin-updater` version on the first real
    // build (same "verify the plugin API" convention as notify()/sysinfo in main.rs).
    // The `notes` PLUMBING is proven independently by classify()'s unit tests.
    Ok(found.map(|u| UpdateInfo { version: u.version.clone(), notes: None }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::UpdatePhase;

    #[test]
    fn classify_reports_up_to_date_when_no_update() {
        let r = classify("0.1.0", None);
        assert_eq!(r.phase, UpdatePhase::UpToDate);
        assert_eq!(r.current_version, "0.1.0");
        assert_eq!(r.available_version, None);
        assert_eq!(r.notes, None);
        assert_eq!(r.error, None);
    }

    #[test]
    fn classify_reports_available_with_version_and_notes() {
        let r = classify(
            "0.1.0",
            Some(UpdateInfo { version: "0.2.0".into(), notes: Some("Bug fixes".into()) }),
        );
        assert_eq!(r.phase, UpdatePhase::UpdateAvailable);
        assert_eq!(r.current_version, "0.1.0");
        assert_eq!(r.available_version.as_deref(), Some("0.2.0"));
        assert_eq!(r.notes.as_deref(), Some("Bug fixes"));
        assert_eq!(r.error, None);
    }

    #[test]
    fn classify_available_without_notes_is_allowed() {
        let r = classify("1.0.0", Some(UpdateInfo { version: "1.1.0".into(), notes: None }));
        assert_eq!(r.phase, UpdatePhase::UpdateAvailable);
        assert_eq!(r.available_version.as_deref(), Some("1.1.0"));
        assert_eq!(r.notes, None);
    }

    #[test]
    fn error_status_is_non_blocking_and_typed() {
        // The offline / placeholder-gate path (§18): a benign, typed status the UI
        // renders as "couldn't check", never a hard failure.
        let r = UpdateCheckResult::error("0.1.0", "network unreachable");
        assert_eq!(r.phase, UpdatePhase::Error);
        assert_eq!(r.current_version, "0.1.0");
        assert_eq!(r.available_version, None);
        assert!(r.error.is_some());
    }
}
