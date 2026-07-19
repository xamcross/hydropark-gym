#![allow(dead_code)] // Phase-1 device-identity core; some accessors are used only by main.rs wiring / tests.

//! Device identity + step-up signing (P1-09.3 / P1-09.8 client half).
//!
//! Two responsibilities, both fully offline and persisted in the on-device SQLite
//! store (`store.rs`, `device_identity` singleton row):
//!
//!  1. A **stable install id** — a v4 UUID minted exactly once, then read back
//!     verbatim on every later call — plus a **coarse hardware fingerprint**
//!     derived from a few upgrade-tolerant `sysinfo` signals. The install id is
//!     what the app surfaces as its `deviceId` and what a license is bound to at
//!     issuance; the fingerprint is the coarse value `POST /v1/devices/register`
//!     stores server-side. Per §13.12 the fingerprint is never re-derived offline
//!     to *verify* a license — only sent at registration.
//!
//!  2. A persisted **Ed25519 device keypair** for the client half of step-up
//!     (P1-09.8): [`sign_challenge`] signs a server-issued challenge string with
//!     the device secret key; the signature verifies under the device public key.
//!
//! The fingerprint is captured once at first run (not recomputed per call) so a
//! RAM/disk/CPU upgrade does not silently change the device's stored identity.

use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::store::{Store, StoreError, StoredDeviceIdentity};

/// Length of an Ed25519 secret-key seed.
const SEED_LEN: usize = 32;

/// Why a device-identity operation failed.
#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("device store error: {0}")]
    Store(#[from] StoreError),
    #[error("stored device signing key is malformed (not a 32-byte seed)")]
    BadKey,
    /// `mark_registered` was called before any identity existed (should not happen).
    #[error("no device identity to update")]
    NoIdentity,
}

impl From<DeviceError> for crate::ipc::CmdError {
    fn from(e: DeviceError) -> Self {
        crate::ipc::CmdError::Account(e.to_string())
    }
}

/// The result of signing a step-up challenge (P1-09.8 client half).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepUpSignature {
    /// Standard-base64 of the 64-byte Ed25519 signature over the challenge bytes.
    pub signature: String,
    /// The stable install id (also handed back to the caller as `deviceId`).
    pub device_id: String,
}

/// Ensure this install has a persisted identity (install id + keypair +
/// fingerprint), minting one on first call and returning the **same** record on
/// every later call. This is the stability guarantee `deviceId` relies on.
pub fn ensure_identity(store: &Arc<Mutex<Store>>) -> Result<StoredDeviceIdentity, DeviceError> {
    let guard = lock(store);
    if let Some(existing) = guard.load_device_identity()? {
        return Ok(existing);
    }
    let install_id = uuid::Uuid::new_v4().to_string();
    let seed = random_seed();
    let fingerprint = coarse_fingerprint();
    guard.save_device_identity(&install_id, &seed, Some(&fingerprint), None, false)?;
    Ok(StoredDeviceIdentity {
        install_id,
        signing_key: seed.to_vec(),
        fingerprint: Some(fingerprint),
        server_device_id: None,
        registered: false,
        recovery_code: None,
    })
}

/// Record that the backend accepted this device's registration: flip `registered`
/// and remember the server-assigned device id, preserving the install id, key, and
/// fingerprint.
pub fn mark_registered(
    store: &Arc<Mutex<Store>>,
    server_device_id: &str,
) -> Result<(), DeviceError> {
    let guard = lock(store);
    let id = guard.load_device_identity()?.ok_or(DeviceError::NoIdentity)?;
    guard.save_device_identity(
        &id.install_id,
        &id.signing_key,
        id.fingerprint.as_deref(),
        Some(server_device_id),
        true,
    )?;
    Ok(())
}

/// Persist the device-only account's recovery code (P0 step-up fix — see
/// `store::migrate_v3_to_v4`'s doc for the full root-cause chain). Best-effort
/// safe to call any time after `ensure_identity` — writing before an identity
/// row exists is a harmless no-op in the store layer, but callers should still
/// ensure an identity first so the write actually lands.
pub fn save_recovery_code(store: &Arc<Mutex<Store>>, recovery_code: &str) -> Result<(), DeviceError> {
    lock(store).save_recovery_code(recovery_code)?;
    Ok(())
}

/// The persisted recovery code for this install's device-only account, if any
/// was ever captured (`None` for a full email/password account, or before any
/// identity/session exists at all).
pub fn recovery_code(store: &Arc<Mutex<Store>>) -> Result<Option<String>, DeviceError> {
    Ok(lock(store).load_device_identity()?.and_then(|d| d.recovery_code))
}

/// Sign a server-issued step-up `challenge` with the persisted device secret key
/// (P1-09.8). Ensures an identity exists first, so it is safe to call standalone.
pub fn sign_challenge(
    store: &Arc<Mutex<Store>>,
    challenge: &str,
) -> Result<StepUpSignature, DeviceError> {
    let identity = ensure_identity(store)?;
    let key = signing_key_from(&identity.signing_key)?;
    let sig = key.sign(challenge.as_bytes());
    Ok(StepUpSignature {
        signature: STANDARD.encode(sig.to_bytes()),
        device_id: identity.install_id,
    })
}

/// A human-readable default name for this device's registry slot.
pub fn default_device_name() -> String {
    let host = sysinfo::System::host_name().unwrap_or_else(|| "Hydropark device".to_string());
    format!("{host} ({})", std::env::consts::OS)
}

/// The coarse fingerprint for a stored identity (or a freshly computed one if,
/// improbably, none was stored). This is the value sent to `/v1/devices/register`.
pub fn fingerprint(identity: &StoredDeviceIdentity) -> String {
    identity.fingerprint.clone().unwrap_or_else(coarse_fingerprint)
}

/// The Ed25519 public key for a stored identity — used to verify a signature
/// this device produced (and by the step-up tests).
pub fn verifying_key(identity: &StoredDeviceIdentity) -> Result<VerifyingKey, DeviceError> {
    Ok(signing_key_from(&identity.signing_key)?.verifying_key())
}

// --- internals -------------------------------------------------------------

fn lock(store: &Arc<Mutex<Store>>) -> std::sync::MutexGuard<'_, Store> {
    store.lock().expect("device store mutex poisoned")
}

/// The Ed25519 signing key reconstituted from a stored 32-byte seed.
fn signing_key_from(seed: &[u8]) -> Result<SigningKey, DeviceError> {
    let arr: [u8; SEED_LEN] = seed.try_into().map_err(|_| DeviceError::BadKey)?;
    Ok(SigningKey::from_bytes(&arr))
}

/// 32 cryptographically-random bytes from the OS RNG (the Ed25519 seed).
fn random_seed() -> [u8; SEED_LEN] {
    let mut seed = [0u8; SEED_LEN];
    getrandom::getrandom(&mut seed).expect("OS RNG is available for device key generation");
    seed
}

/// A coarse, upgrade-tolerant hardware fingerprint: SHA-256 over a handful of
/// stable signals (hostname, OS name, CPU brand, physical core count, whole-GiB
/// RAM), hex-encoded behind a scheme-version prefix. Deliberately coarse so it
/// cannot double as a hardware-locked license (§13.12) and does not churn on small
/// upgrades — and it is stored once at first run regardless, so even a signal that
/// *does* change later never alters this device's persisted identity.
fn coarse_fingerprint() -> String {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_memory();
    let host = System::host_name().unwrap_or_default();
    let os = System::name().unwrap_or_default();
    let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let cores = sys.physical_core_count().unwrap_or(0);
    let ram_gib = sys.total_memory() / (1024 * 1024 * 1024);
    let canonical =
        format!("hp-device|host={host}|os={os}|cpu={cpu}|cores={cores}|ram_gib={ram_gib}");
    let digest = Sha256::digest(canonical.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("fp1-{hex}")
}

// ===========================================================================
// Tests — in-memory store; no network, no model. sysinfo reads real hardware
// but only needs to not panic.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signature;

    fn store() -> Arc<Mutex<Store>> {
        Arc::new(Mutex::new(Store::open_in_memory().expect("in-memory store opens")))
    }

    #[test]
    fn device_id_is_stable_across_calls() {
        let s = store();
        let a = ensure_identity(&s).unwrap();
        let b = ensure_identity(&s).unwrap();
        assert_eq!(a.install_id, b.install_id, "install id is minted once, then reused");
        assert_eq!(a.signing_key, b.signing_key, "the keypair persists too");
        assert_eq!(a.fingerprint, b.fingerprint, "the fingerprint is captured once");
        assert!(!a.install_id.is_empty());
        assert_eq!(a.signing_key.len(), SEED_LEN);
        assert!(a.fingerprint.as_deref().unwrap().starts_with("fp1-"));
    }

    #[test]
    fn step_up_signature_verifies_with_device_pubkey() {
        let s = store();
        let challenge = "chal_9f8e7d6c-server-issued";
        let signed = sign_challenge(&s, challenge).unwrap();

        // The returned deviceId is the stable install id.
        let identity = ensure_identity(&s).unwrap();
        assert_eq!(signed.device_id, identity.install_id);

        // The signature verifies under the persisted device public key...
        let vk = verifying_key(&identity).unwrap();
        let raw = STANDARD.decode(&signed.signature).unwrap();
        let bytes: [u8; 64] = raw.as_slice().try_into().expect("64-byte Ed25519 signature");
        let sig = Signature::from_bytes(&bytes);
        assert!(vk.verify_strict(challenge.as_bytes(), &sig).is_ok());

        // ...and does not verify over a different challenge.
        assert!(vk.verify_strict(b"a different challenge", &sig).is_err());
    }

    /// P0 step-up fix: the recovery code round-trips through the device
    /// module's helpers exactly like the rest of the identity does.
    #[test]
    fn recovery_code_round_trips_once_an_identity_exists() {
        let s = store();
        assert_eq!(recovery_code(&s).unwrap(), None, "nothing captured yet");

        ensure_identity(&s).unwrap();
        save_recovery_code(&s, "rc-9f8e7d").unwrap();
        assert_eq!(recovery_code(&s).unwrap().as_deref(), Some("rc-9f8e7d"));

        // Preserved across an unrelated identity update (mirrors mark_registered).
        mark_registered(&s, "srv-dev-1").unwrap();
        assert_eq!(recovery_code(&s).unwrap().as_deref(), Some("rc-9f8e7d"));
    }

    #[test]
    fn mark_registered_preserves_identity_and_sets_server_id() {
        let s = store();
        let before = ensure_identity(&s).unwrap();
        assert!(!before.registered);

        mark_registered(&s, "srv-dev-42").unwrap();

        let after = ensure_identity(&s).unwrap();
        assert_eq!(after.install_id, before.install_id, "install id unchanged");
        assert_eq!(after.signing_key, before.signing_key, "keypair unchanged");
        assert!(after.registered);
        assert_eq!(after.server_device_id.as_deref(), Some("srv-dev-42"));
    }
}
