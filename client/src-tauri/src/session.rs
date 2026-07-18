#![allow(dead_code)] // Phase-1 account/session core; some helpers are used only by main.rs wiring / tests.

//! Account session persistence + refresh-on-expiry (P1-09.x client half).
//!
//! The Rust core owns the account session: the access + refresh token pair minted
//! by `/v1/auth` is persisted in the on-device SQLite store (`store.rs`,
//! `auth_session` singleton row) and re-attached as the `Authorization: Bearer`
//! on every authed backend call — the webview never handles a raw token (its CSP
//! is `connect-src 'self'`, so it cannot talk to the backend at all).
//!
//! [`SessionManager`] is the single managed handle the Tauri commands drive. It
//! carries the shared [`BackendClient`] (so it can refresh) and the store
//! `Arc<Mutex<_>>` (so the device/entitlement flows reach the same store).
//!
//! Refresh-on-expiry is proactive: [`SessionManager::bearer`] reads the stored
//! access token's `exp` (decoded, **never** cryptographically verified — the
//! backend is the authority) and rotates via `/v1/auth/refresh` when it is at or
//! near expiry, persisting the new pair. The store `Mutex` guard is always dropped
//! before an `.await`, so the command futures stay `Send`.

use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::Value;

use crate::backend_client::{AuthSession, BackendClient, BackendError};
use crate::device;
use crate::ipc::EntitlementItem;
use crate::store::{Store, StoreError, StoredSession};

/// Rotate this many ms BEFORE the access token's `exp` so a call never races the
/// token's expiry (clock skew + request latency headroom).
const REFRESH_SKEW_MS: i64 = 60_000;

/// Why a session operation failed: a backend call, or the on-device store.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Backend(#[from] BackendError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl From<SessionError> for crate::ipc::CmdError {
    fn from(e: SessionError) -> Self {
        match e {
            // Reuse BackendError → CmdError::Backend (keeps the transport taxonomy).
            SessionError::Backend(b) => b.into(),
            SessionError::Store(s) => crate::ipc::CmdError::Account(s.to_string()),
        }
    }
}

/// Decode a JWT's `exp` claim (seconds since epoch) into epoch **milliseconds**.
/// Best-effort and signature-agnostic — used only to schedule a proactive refresh,
/// so a malformed/opaque token simply yields `None` (treated as "expiry unknown").
pub fn access_exp_ms(access_jwt: &str) -> Option<i64> {
    let payload = access_jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("exp")
        .and_then(Value::as_i64)
        .map(|secs| secs.saturating_mul(1000))
}

/// Whether `session`'s access token should be refreshed before use at `now_ms`.
/// A token whose expiry we could not read is treated as usable (fail-open: the
/// backend will 401 if it is actually stale, and the webview re-authenticates).
pub fn needs_refresh(session: &StoredSession, now_ms: i64, skew_ms: i64) -> bool {
    match session.access_exp_ms {
        Some(exp) => now_ms.saturating_add(skew_ms) >= exp,
        None => false,
    }
}

/// The managed account/session handle (`.manage()`-d in `main.rs`). Cheap to
/// clone: an `Arc` to the store + a clone of the shared reqwest-backed client.
#[derive(Clone)]
pub struct SessionManager {
    store: Arc<Mutex<Store>>,
    client: BackendClient,
}

impl SessionManager {
    pub fn new(store: Arc<Mutex<Store>>, client: BackendClient) -> Self {
        Self { store, client }
    }

    /// The shared on-device store — the device and entitlement flows use it too.
    pub fn store(&self) -> &Arc<Mutex<Store>> {
        &self.store
    }

    /// A clone of the shared backend client.
    pub fn client(&self) -> BackendClient {
        self.client.clone()
    }

    /// The currently-persisted session, or `None` when signed out.
    pub fn current(&self) -> Option<StoredSession> {
        self.lock().load_session().ok().flatten()
    }

    /// Register a new account, persisting the returned token pair.
    pub async fn register(&self, email: &str, password: &str) -> Result<(), SessionError> {
        let issued = self.client.auth_register(email, password).await?;
        self.persist(&issued)?;
        Ok(())
    }

    /// Log in, persisting the returned token pair.
    pub async fn login(&self, email: &str, password: &str) -> Result<(), SessionError> {
        let issued = self.client.auth_login(email, password).await?;
        self.persist(&issued)?;
        Ok(())
    }

    /// The email-optional "device identity" path (SPEC §12/§13, P0 fix): when
    /// this install is still fully anonymous (`current()` is `None`), mint a
    /// device-only backend account (`POST /v1/auth/register` with no
    /// credentials) and persist its token pair as the session — exactly like
    /// [`Self::register`]/[`Self::login`] do — so `bearer()` stops being `None`
    /// and the authed commerce calls (`order_checkout`/`license_fetch`/
    /// `download_url`) stop 401ing for a never-signed-in user.
    ///
    /// Idempotent: a session already exists (device-only OR a full account) →
    /// no-op, so repeated calls (e.g. every `device_ensure` invocation) never
    /// mint a second account for the same install.
    ///
    /// P0 step-up fix: a device-only register response also carries a one-time
    /// `recovery_code` — this account's ONLY step-up factor (SPEC §8;
    /// `StepUpService.begin` returns `factor="recovery_code"` for an email-less
    /// account, presented directly as `X-Step-Up-Token`, no challenge
    /// round-trip). It must be captured HERE, at the moment the account and its
    /// server-side `recovery_code_hash` are minted together — there is no later
    /// endpoint that reissues or re-displays it. Persisted alongside the device
    /// identity (`device::save_recovery_code`), not in `auth_session`, so it
    /// survives independently of the token pair's own lifecycle. Best-effort:
    /// a failure to persist it must not fail registration itself (the caller
    /// already has a working session; losing the step-up factor only means a
    /// later `license.issue` 403s and can be retried after re-registering).
    pub async fn ensure_device_session(&self) -> Result<(), SessionError> {
        if self.current().is_some() {
            return Ok(());
        }
        let issued = self.client.auth_register_device().await?;
        self.persist(&issued)?;
        if let Some(code) = issued.recovery_code.as_deref().filter(|c| !c.trim().is_empty()) {
            // Best-effort: ensure the device_identity row exists (idempotent —
            // `device_ensure` normally already minted it before calling this),
            // then persist the recovery code onto it.
            let _ = device::ensure_identity(&self.store);
            if let Err(e) = device::save_recovery_code(&self.store, code) {
                eprintln!("[session] failed to persist device-only recovery code: {e}");
            }
        }
        Ok(())
    }

    /// Log out: best-effort revoke the refresh token server-side, then clear the
    /// local session unconditionally (a network hiccup must not strand the user
    /// signed-in locally).
    pub async fn logout(&self) -> Result<(), SessionError> {
        if let Some(s) = self.current() {
            let _ = self.client.auth_logout(&s.refresh_token).await;
        }
        self.lock().clear_session()?;
        Ok(())
    }

    /// The bearer to attach to an authed call: the stored access token, rotated
    /// first if at/near expiry. `None` ⇒ no session (the call proceeds anonymously).
    ///
    /// The store guard is dropped inside [`Self::current`] before the refresh
    /// `.await`, and re-taken (and dropped) inside [`Self::save_tokens`] after it.
    pub async fn bearer(&self) -> Option<String> {
        let session = self.current()?;
        if !needs_refresh(&session, now_ms(), REFRESH_SKEW_MS) {
            return Some(session.access_token);
        }
        match self.client.auth_refresh(&session.refresh_token).await {
            Ok(issued) => {
                let access = issued.access_token.clone();
                // Preserve the known email across a refresh (TokenPair carries none).
                let _ =
                    self.save_tokens(&issued.access_token, &issued.refresh_token, session.email.as_deref());
                Some(access)
            }
            // Fail-open: hand back the stale token; the backend arbitrates validity.
            Err(_) => Some(session.access_token),
        }
    }

    /// Refresh entitlements from the backend and cache them locally (P1-09.7).
    /// Attaches the session bearer automatically; safe to call when signed out
    /// (the backend returns the anonymous/empty set).
    pub async fn refresh_entitlements(&self) -> Result<Vec<EntitlementItem>, SessionError> {
        let bearer = self.bearer().await;
        let skills = self.client.entitlements_get(bearer.as_deref()).await?;
        let rows: Vec<(String, String)> =
            skills.iter().map(|s| (s.skill_id.clone(), s.status.clone())).collect();
        self.lock().cache_entitlements(&rows, now_ms())?;
        Ok(skills)
    }

    // --- internals ---------------------------------------------------------

    fn persist(&self, issued: &AuthSession) -> Result<(), StoreError> {
        self.save_tokens(&issued.access_token, &issued.refresh_token, issued.email.as_deref())
    }

    fn save_tokens(
        &self,
        access: &str,
        refresh: &str,
        email: Option<&str>,
    ) -> Result<(), StoreError> {
        let exp = access_exp_ms(access);
        self.lock().save_session(access, refresh, email, exp)
    }

    /// Lock the store, panicking only on a poisoned mutex (a prior panic while
    /// holding it — unrecoverable). The returned guard is always short-lived and
    /// dropped before any `.await`.
    fn lock(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().expect("session store mutex poisoned")
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ===========================================================================
// Tests — pure token/refresh logic + a store-backed round-trip. No network.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> SessionManager {
        let store = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
        // The base is never dialed in these tests (no register/login/bearer call).
        SessionManager::new(store, BackendClient::with_base("http://unused.invalid"))
    }

    /// Build a syntactically-valid JWT whose payload carries `exp` (seconds).
    fn jwt_with_exp(exp_secs: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","typ":"JWT"}"#);
        let payload =
            URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"u1","exp":{exp_secs}}}"#).as_bytes());
        format!("{header}.{payload}.c2ln")
    }

    #[test]
    fn access_exp_ms_reads_jwt_exp_and_ignores_junk() {
        assert_eq!(access_exp_ms(&jwt_with_exp(1_770_000_000)), Some(1_770_000_000_000));
        assert_eq!(access_exp_ms("not-a-jwt"), None);
        assert_eq!(access_exp_ms("a.b"), None, "payload 'b' is not base64url JSON");
        // A valid JWT with no exp claim → unknown expiry.
        let no_exp = {
            let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256"}"#);
            let p = URL_SAFE_NO_PAD.encode(br#"{"sub":"u1"}"#);
            format!("{h}.{p}.sig")
        };
        assert_eq!(access_exp_ms(&no_exp), None);
    }

    #[test]
    fn needs_refresh_selects_by_expiry_with_skew() {
        let base = StoredSession {
            access_token: "a".into(),
            refresh_token: "r".into(),
            email: None,
            access_exp_ms: Some(10_000_000),
        };
        // Comfortably before expiry (outside the skew window): keep the token.
        assert!(!needs_refresh(&base, 9_000_000, REFRESH_SKEW_MS));
        // Inside the skew window before expiry: refresh proactively.
        assert!(needs_refresh(&base, 9_990_000, REFRESH_SKEW_MS));
        // At/after expiry: refresh.
        assert!(needs_refresh(&base, 10_000_001, REFRESH_SKEW_MS));
        // Unknown expiry: fail-open (usable even at t = MAX).
        let unknown = StoredSession { access_exp_ms: None, ..base };
        assert!(!needs_refresh(&unknown, i64::MAX, REFRESH_SKEW_MS));
    }

    #[test]
    fn token_store_round_trips_and_refresh_selection_follows() {
        let mgr = manager();
        assert!(mgr.current().is_none(), "no session initially");

        let exp_secs = 2_000_000_000;
        let access = jwt_with_exp(exp_secs);
        mgr.save_tokens(&access, "refresh-xyz", Some("chef@example.com")).unwrap();

        let loaded = mgr.current().expect("session persisted");
        assert_eq!(loaded.access_token, access);
        assert_eq!(loaded.refresh_token, "refresh-xyz");
        assert_eq!(loaded.email.as_deref(), Some("chef@example.com"));
        assert_eq!(
            loaded.access_exp_ms,
            Some(exp_secs * 1000),
            "the access token's exp is decoded and stored on save"
        );

        // The stored exp drives refresh selection: fresh now → keep; past exp → refresh.
        assert!(!needs_refresh(&loaded, exp_secs * 1000 - 5 * REFRESH_SKEW_MS, REFRESH_SKEW_MS));
        assert!(needs_refresh(&loaded, exp_secs * 1000, REFRESH_SKEW_MS));

        // Clearing removes it (the local half of logout).
        mgr.lock().clear_session().unwrap();
        assert!(mgr.current().is_none());
    }

    /// `ensure_device_session` must be a true no-op once ANY session already
    /// exists — it must not re-dial the backend (the manager's client points at
    /// an unreachable base; a network call here would fail the test) and must
    /// not disturb the already-persisted tokens.
    #[tokio::test]
    async fn ensure_device_session_is_a_noop_once_a_session_exists() {
        let mgr = manager();
        let exp_secs = 2_000_000_000;
        let access = jwt_with_exp(exp_secs);
        mgr.save_tokens(&access, "refresh-xyz", Some("chef@example.com")).unwrap();

        mgr.ensure_device_session().await.expect("no-op must not dial the (unreachable) backend");

        let after = mgr.current().expect("existing session preserved");
        assert_eq!(after.access_token, access, "no-op must not overwrite the existing session");
        assert_eq!(after.refresh_token, "refresh-xyz");
    }

    /// P0 step-up fix, end-to-end through this layer: a fresh device-only
    /// register (a real request/response round-trip against a loopback stub,
    /// not just a pure decode check) must persist BOTH the session token pair
    /// AND the recovery code the response carries — the code lands in the
    /// device_identity row (`device::recovery_code`), not just somewhere in
    /// memory, so a later `license_fetch` command reading the store back out
    /// after a restart still finds it.
    #[tokio::test]
    async fn ensure_device_session_persists_the_recovery_code_alongside_device_identity() {
        let auth_response = br#"{
            "access_jwt": "a.b.c",
            "refresh_token": "rt-device",
            "user": { "id": "usr_1" },
            "recovery_code": "rc-live-9f8e"
        }"#
        .to_vec();
        let url = crate::backend_client::spawn_stub_server("HTTP/1.1 200 OK", auth_response);
        let origin = url.trim_end_matches("/pkg");
        let store = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
        let mgr = SessionManager::new(store.clone(), BackendClient::with_base(origin));

        mgr.ensure_device_session().await.expect("registers a device-only session against the stub");

        let session = mgr.current().expect("session persisted");
        assert_eq!(session.access_token, "a.b.c");
        assert_eq!(session.refresh_token, "rt-device");

        let code = device::recovery_code(&store).unwrap();
        assert_eq!(
            code.as_deref(),
            Some("rc-live-9f8e"),
            "recovery code must be persisted alongside the device identity, not discarded"
        );
    }
}
