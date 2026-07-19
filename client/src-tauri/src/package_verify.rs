#![allow(dead_code)] // Phase-1 install-path core; wired into the installer in a later ticket.

//! Offline skill-package signature verification (P1-03.3, SPEC §8.8, §13.3, §13.8).
//!
//! Every skill package ships a manifest whose top level carries a detached
//! Ed25519 `signature` and the `signing_key_id` (`kid`) that produced it. The
//! backend signs the manifest **canonicalized with RFC 8785 JCS**, over the
//! manifest with the top-level `signature` and `signing_key_id` fields
//! **removed**. The client re-derives those exact bytes and checks the signature
//! against a pinned *trusted-key set* (§13.8) **before** anything is installed —
//! entirely offline, no network, no trust in the download channel.
//!
//! Correctness across the two languages hinges on the canonicalization being
//! byte-identical to the backend's. A cross-language golden vector
//! (`contracts/testdata/package-signing-golden.json`) pins that: its
//! `jcs_canonical` field is the JCS string the backend signed, and the tests
//! below assert [`canonical_bytes`] reproduces it byte-for-byte.
//!
//! Like `orchestrator`, this module is free of Tauri/inference coupling so it is
//! pure and unit-testable.

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};

/// Wire prefix on the manifest `signature` string (`ed25519:<base64>`).
const SIGNATURE_PREFIX: &str = "ed25519:";

/// The fixed 12-byte DER prefix of an X.509 `SubjectPublicKeyInfo` wrapping an
/// Ed25519 key (OID 1.3.101.112). A full Ed25519 SPKI is this prefix followed by
/// the 32-byte raw public key — 44 bytes total. Parsing just this shape lets us
/// avoid pulling in a full DER/PKCS#8 parser (and ed25519-dalek's `pkcs8`
/// feature).
const ED25519_SPKI_PREFIX: [u8; 12] =
    [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// Total byte length of an Ed25519 X.509 SPKI: 12-byte prefix + 32-byte key.
const ED25519_SPKI_LEN: usize = ED25519_SPKI_PREFIX.len() + 32;

/// Length of a raw Ed25519 signature.
const SIGNATURE_LEN: usize = 64;

/// Why a package manifest failed verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageVerifyError {
    /// The manifest has no `signature` / `signing_key_id`, or they are not strings.
    MissingSignature,
    /// The `signature` is present but not `ed25519:<base64>` decoding to 64 bytes.
    MalformedSignature,
    /// The manifest's `signing_key_id` is not in the trusted-key set.
    UnknownKid,
    /// A trusted-key entry was not a valid 44-byte Ed25519 X.509 SPKI key.
    BadPublicKey,
    /// The signature did not verify against the trusted key (tampered or forged).
    SignatureMismatch,
}

impl std::fmt::Display for PackageVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PackageVerifyError::MissingSignature => {
                write!(f, "manifest is missing a string `signature` or `signing_key_id`")
            }
            PackageVerifyError::MalformedSignature => {
                write!(f, "manifest `signature` is not `ed25519:<base64>` decoding to {SIGNATURE_LEN} bytes")
            }
            PackageVerifyError::UnknownKid => {
                write!(f, "manifest `signing_key_id` is not in the trusted-key set")
            }
            PackageVerifyError::BadPublicKey => {
                write!(f, "trusted key is not a valid Ed25519 X.509 SPKI public key")
            }
            PackageVerifyError::SignatureMismatch => {
                write!(f, "manifest signature did not verify against the trusted key")
            }
        }
    }
}

impl std::error::Error for PackageVerifyError {}

/// The canonical bytes the signature covers: the manifest with the top-level
/// `signature` and `signing_key_id` removed, serialized with RFC 8785 JCS.
///
/// This MUST be byte-identical to what the backend signs; the golden vector in
/// the tests is the cross-language proof.
pub fn canonical_bytes(manifest: &serde_json::Value) -> Vec<u8> {
    let mut stripped = manifest.clone();
    if let Some(obj) = stripped.as_object_mut() {
        obj.remove("signature");
        obj.remove("signing_key_id");
    }
    // JCS serialization of an in-memory `serde_json::Value` cannot fail: every
    // value is representable and key ordering is total.
    serde_jcs::to_vec(&stripped).expect("JCS canonicalization of a JSON value is infallible")
}

/// The pinned set of package-signing keys the client trusts (SPEC §13.8),
/// indexed by `kid`.
#[derive(Debug, Clone, Default)]
pub struct PackageTrustedKeys {
    keys: BTreeMap<String, VerifyingKey>,
}

impl PackageTrustedKeys {
    /// An empty trusted-key set.
    pub fn new() -> Self {
        Self { keys: BTreeMap::new() }
    }

    /// Trust `kid`'s key, given as a base64-encoded X.509 SPKI Ed25519 public key.
    ///
    /// The blob is validated as a 44-byte Ed25519 SPKI (standard 12-byte prefix +
    /// 32-byte key); the trailing 32 bytes are the raw key.
    pub fn insert_spki_b64(
        &mut self,
        kid: impl Into<String>,
        spki_b64: &str,
    ) -> Result<(), PackageVerifyError> {
        let key = verifying_key_from_spki_b64(spki_b64)?;
        self.keys.insert(kid.into(), key);
        Ok(())
    }

    /// Build a trusted-key set from `(kid, spki_b64)` pairs.
    pub fn from_spki_b64<I, K>(entries: I) -> Result<Self, PackageVerifyError>
    where
        I: IntoIterator<Item = (K, String)>,
        K: Into<String>,
    {
        let mut set = Self::new();
        for (kid, spki_b64) in entries {
            set.insert_spki_b64(kid, &spki_b64)?;
        }
        Ok(set)
    }

    /// The verifying key trusted for `kid`, if any.
    pub fn get(&self, kid: &str) -> Option<&VerifyingKey> {
        self.keys.get(kid)
    }

    /// Number of trusted keys.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// Whether the set is empty.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// Decode a base64 X.509 SPKI Ed25519 public key into a [`VerifyingKey`].
fn verifying_key_from_spki_b64(spki_b64: &str) -> Result<VerifyingKey, PackageVerifyError> {
    let der = STANDARD
        .decode(spki_b64.trim())
        .map_err(|_| PackageVerifyError::BadPublicKey)?;
    if der.len() != ED25519_SPKI_LEN || der[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX {
        return Err(PackageVerifyError::BadPublicKey);
    }
    let mut raw = [0u8; 32];
    raw.copy_from_slice(&der[ED25519_SPKI_PREFIX.len()..]);
    VerifyingKey::from_bytes(&raw).map_err(|_| PackageVerifyError::BadPublicKey)
}

/// Verify a skill-package manifest's Ed25519 signature against the trusted-key
/// set, offline.
///
/// Reads the top-level `signing_key_id` and `signature` (`ed25519:<base64>`,
/// 64 raw bytes), looks the `kid` up in `trusted`, re-derives [`canonical_bytes`],
/// and checks the signature with `verify_strict` (which rejects non-canonical
/// signatures and small-order keys). Returns `Ok(())` only on a valid signature.
pub fn verify(
    manifest: &serde_json::Value,
    trusted: &PackageTrustedKeys,
) -> Result<(), PackageVerifyError> {
    let obj = manifest.as_object().ok_or(PackageVerifyError::MissingSignature)?;

    let kid = obj
        .get("signing_key_id")
        .and_then(serde_json::Value::as_str)
        .ok_or(PackageVerifyError::MissingSignature)?;

    let sig_wire = obj
        .get("signature")
        .and_then(serde_json::Value::as_str)
        .ok_or(PackageVerifyError::MissingSignature)?;

    let signature = parse_signature(sig_wire)?;

    let key = trusted.get(kid).ok_or(PackageVerifyError::UnknownKid)?;

    let message = canonical_bytes(manifest);
    key.verify_strict(&message, &signature)
        .map_err(|_| PackageVerifyError::SignatureMismatch)
}

/// Parse an `ed25519:<base64>` wire signature into a [`Signature`] (exactly 64 bytes).
fn parse_signature(wire: &str) -> Result<Signature, PackageVerifyError> {
    let b64 = wire
        .strip_prefix(SIGNATURE_PREFIX)
        .ok_or(PackageVerifyError::MalformedSignature)?;
    let raw = STANDARD
        .decode(b64)
        .map_err(|_| PackageVerifyError::MalformedSignature)?;
    let bytes: [u8; SIGNATURE_LEN] =
        raw.as_slice().try_into().map_err(|_| PackageVerifyError::MalformedSignature)?;
    Ok(Signature::from_bytes(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cross-language golden vector shared with the backend signer.
    #[derive(serde::Deserialize)]
    struct GoldenVector {
        manifest: serde_json::Value,
        package_public_key_b64: String,
        kid: String,
        jcs_canonical: String,
    }

    fn golden() -> GoldenVector {
        let raw = include_str!("../../../contracts/testdata/package-signing-golden.json");
        serde_json::from_str(raw).expect("golden vector parses")
    }

    fn trusted_from_golden(g: &GoldenVector) -> PackageTrustedKeys {
        PackageTrustedKeys::from_spki_b64([(g.kid.clone(), g.package_public_key_b64.clone())])
            .expect("golden public key is a valid Ed25519 SPKI")
    }

    /// THE cross-language gate: our JCS canonicalization must reproduce the exact
    /// string the backend signed, byte-for-byte.
    #[test]
    fn canonical_bytes_match_backend_jcs_byte_for_byte() {
        let g = golden();
        let produced =
            String::from_utf8(canonical_bytes(&g.manifest)).expect("JCS output is valid UTF-8");
        assert_eq!(
            produced, g.jcs_canonical,
            "Rust serde_jcs canonicalization diverged from the backend JCS"
        );
    }

    /// verify() accepts the golden manifest with the golden key trusted.
    #[test]
    fn verify_accepts_golden_manifest() {
        let g = golden();
        let trusted = trusted_from_golden(&g);
        assert_eq!(verify(&g.manifest, &trusted), Ok(()));
    }

    /// A one-field byte tamper of a signed manifest fails as SignatureMismatch.
    #[test]
    fn tampered_manifest_is_signature_mismatch() {
        let g = golden();
        let trusted = trusted_from_golden(&g);
        let mut tampered = g.manifest.clone();
        tampered["name"] = serde_json::Value::String("Golden Vector — TAMPERED".to_string());
        assert_eq!(verify(&tampered, &trusted), Err(PackageVerifyError::SignatureMismatch));
    }

    /// A manifest whose kid is not trusted fails as UnknownKid.
    #[test]
    fn unknown_kid_is_rejected() {
        let g = golden();
        let empty = PackageTrustedKeys::new();
        assert_eq!(verify(&g.manifest, &empty), Err(PackageVerifyError::UnknownKid));

        // Trusting a *different* kid still leaves the manifest's kid unknown.
        let mut other = PackageTrustedKeys::new();
        other
            .insert_spki_b64("some-other-kid", &g.package_public_key_b64)
            .unwrap();
        assert_eq!(verify(&g.manifest, &other), Err(PackageVerifyError::UnknownKid));
    }

    /// A mangled `signature` string fails as MalformedSignature, before key lookup.
    #[test]
    fn mangled_signature_is_malformed() {
        let g = golden();
        let trusted = trusted_from_golden(&g);

        // Wrong length after decode (3 bytes, not 64).
        let mut short = g.manifest.clone();
        short["signature"] = serde_json::Value::String("ed25519:AAAA".to_string());
        assert_eq!(verify(&short, &trusted), Err(PackageVerifyError::MalformedSignature));

        // Missing the `ed25519:` scheme prefix.
        let mut no_prefix = g.manifest.clone();
        no_prefix["signature"] = serde_json::Value::String(
            "NUIv2dZaDi/Q6hrSh1uaGh2GklngcdZy1S7zplzz3DaeyjqYuSZFKyBLnpt2wFBkndRN3//kbQjKflxgZOYNAw=="
                .to_string(),
        );
        assert_eq!(verify(&no_prefix, &trusted), Err(PackageVerifyError::MalformedSignature));

        // Not valid base64 at all.
        let mut junk = g.manifest.clone();
        junk["signature"] = serde_json::Value::String("ed25519:!!!not-base64!!!".to_string());
        assert_eq!(verify(&junk, &trusted), Err(PackageVerifyError::MalformedSignature));
    }

    /// Missing / non-string signature fields are MissingSignature.
    #[test]
    fn missing_signature_fields_are_reported() {
        let g = golden();
        let trusted = trusted_from_golden(&g);

        let mut no_sig = g.manifest.clone();
        no_sig.as_object_mut().unwrap().remove("signature");
        assert_eq!(verify(&no_sig, &trusted), Err(PackageVerifyError::MissingSignature));

        let mut no_kid = g.manifest.clone();
        no_kid.as_object_mut().unwrap().remove("signing_key_id");
        assert_eq!(verify(&no_kid, &trusted), Err(PackageVerifyError::MissingSignature));
    }

    /// A trusted-key blob that is not a valid Ed25519 SPKI is rejected at insert.
    #[test]
    fn bad_public_key_is_rejected() {
        let mut set = PackageTrustedKeys::new();
        // Valid base64 but wrong length / prefix.
        assert_eq!(
            set.insert_spki_b64("k", "AAAA"),
            Err(PackageVerifyError::BadPublicKey)
        );
        // Not base64 at all.
        assert_eq!(
            set.insert_spki_b64("k", "%%%not base64%%%"),
            Err(PackageVerifyError::BadPublicKey)
        );
    }
}
