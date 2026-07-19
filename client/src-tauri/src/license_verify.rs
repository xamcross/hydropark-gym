#![allow(dead_code)] // Phase-1 unlock-path core; wired into the entitlement store in a later ticket.

//! Offline license verification (P1-09.4/.5, SPEC §13.12, ADR-001; BACKEND-DESIGN §6.1, §6.3).
//!
//! A license is a **compact, attached JWS** minted by the backend `LicenseSigner`:
//! `base64url(header) . base64url(payload) . base64url(signature)`, signed over the
//! exact ASCII bytes `base64url(header) + '.' + base64url(payload)`. There is **no
//! canonical-JSON step** on this path (unlike `package_verify`): the client verifies
//! the signature over the *exact received bytes* and only then parses the payload, so
//! no re-serialization can ever brick a valid license.
//!
//! The algorithm is **pinned per `kid` by the trusted-key set, never taken from the
//! token header** (the alg-confusion defense, BACKEND-DESIGN §6.1). New issuance is
//! `ES256` (ECDSA P-256 over SHA-256); older deployed licenses are `EdDSA` (Ed25519).
//! [`verify_license`] reads `kid`, looks that key up in the trusted set, reads the
//! algorithm the *trusted set* pinned to it, and verifies with that — additionally
//! **failing closed** if the header `alg` is absent, `none`, or disagrees with the
//! pinned algorithm.
//!
//! Like `package_verify`, this decodes the X.509 SPKI public keys by stripping the
//! fixed algorithm prefix (no full DER parser pulled in), and is free of Tauri /
//! inference coupling so it is pure and unit-testable under `mock-inference`.
//!
//! **`device_id` is required but never re-derived offline** (ADR-001, SPEC §13.12): a
//! verified license must *carry* a `device_id`, but this module does not recompute or
//! compare a hardware fingerprint — device binding is enforced at issuance, not here.
//!
//! The cross-language golden vector (`contracts/testdata/license-es256-golden.json`,
//! copied from `backend/docs/es256-golden-vector.json`) is a real ES256 license JWS
//! minted by the production signer; the tests below verify it end-to-end and at the
//! raw P-256/SHA-256 primitive, pinning that the two languages agree byte-for-byte.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signature as Ed25519Signature, VerifyingKey as Ed25519VerifyingKey};
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature as P256Signature, VerifyingKey as P256VerifyingKey};
use serde_json::{Map, Value};

/// The JWS `typ` every Hydropark license header carries (the format field).
const LICENSE_TYP: &str = "hp-lic+jws";
/// The only issuer a verified license may name.
const EXPECTED_ISSUER: &str = "hydropark-licensing";
/// The only entitlement Phase-1 issues (perpetual, `exp:null`).
const EXPECTED_ENTITLEMENT: &str = "perpetual";
/// The rolling trusted-key window size (K = 5, BACKEND-DESIGN §6.3, §13.8).
const DEFAULT_TRUSTED_SET_SIZE: usize = 5;

/// Fixed 26-byte X.509 SPKI prefix wrapping an EC P-256 (`prime256v1`) public key:
/// `SEQUENCE { AlgorithmIdentifier { ecPublicKey, prime256v1 }, BIT STRING(0 unused) }`
/// followed by the 65-byte uncompressed SEC1 point (`0x04 || X || Y`). Parsing just this
/// shape avoids pulling in a DER/`pkcs8` parser (mirrors `package_verify`'s Ed25519 SPKI handling).
const P256_SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];
/// Length of an uncompressed P-256 SEC1 point (`0x04 || X(32) || Y(32)`).
const P256_SEC1_LEN: usize = 65;
/// Total length of a P-256 X.509 SPKI: 26-byte prefix + 65-byte point.
const P256_SPKI_LEN: usize = P256_SPKI_PREFIX.len() + P256_SEC1_LEN;

/// Fixed 12-byte X.509 SPKI prefix wrapping an Ed25519 public key (OID 1.3.101.112);
/// followed by the 32-byte raw key. Identical to `package_verify`'s constant.
const ED25519_SPKI_PREFIX: [u8; 12] =
    [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
/// Length of a raw Ed25519 public key.
const ED25519_RAW_LEN: usize = 32;
/// Total length of an Ed25519 X.509 SPKI: 12-byte prefix + 32-byte key.
const ED25519_SPKI_LEN: usize = ED25519_SPKI_PREFIX.len() + ED25519_RAW_LEN;

/// Raw signature length for both algorithms: ES256 is the fixed 64-byte `R||S`
/// (RFC 7518 §3.4, *not* DER); Ed25519 is likewise 64 bytes.
const SIGNATURE_LEN: usize = 64;

/// The JWS algorithm pinned to a trusted key. The header's `alg` is checked *against*
/// this — it never selects it (alg-confusion defense).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigAlg {
    /// ECDSA over P-256 with SHA-256 (RFC 7518 `ES256`) — current issuance.
    Es256,
    /// Ed25519 (RFC 8037 `EdDSA`) — legacy deployed keys.
    EdDsa,
}

impl SigAlg {
    /// The exact JWS `alg` header string this algorithm must appear as.
    pub fn jws_name(self) -> &'static str {
        match self {
            SigAlg::Es256 => "ES256",
            SigAlg::EdDsa => "EdDSA",
        }
    }
}

/// One trusted issuer key: its `kid`, the algorithm **pinned** to it, and the public
/// key as X.509 SPKI DER bytes. Holds either a license (`ES256`/`EdDSA`) or package key
/// class — the pinned `alg` is what disambiguates, never the token.
#[derive(Debug, Clone)]
pub struct TrustedKey {
    pub kid: String,
    pub alg: SigAlg,
    /// X.509 SubjectPublicKeyInfo DER bytes (EC P-256 SPKI for `Es256`, Ed25519 SPKI for `EdDsa`).
    pub public_key: Vec<u8>,
}

/// A rolling K = 5 trusted-key window (BACKEND-DESIGN §6.3, §13.8), keyed by `kid`.
///
/// Holds **both** license and package key classes; each entry carries its own pinned
/// [`SigAlg`]. Ordered oldest → newest; inserting past the cap rolls the oldest off,
/// which is exactly how a device that has been offline across several rotations keeps
/// verifying cached tokens under a `kid` it still trusts while old keys age out.
#[derive(Debug, Clone)]
pub struct TrustedKeySet {
    keys: Vec<TrustedKey>, // oldest -> newest
    max_size: usize,
}

impl Default for TrustedKeySet {
    fn default() -> Self {
        Self::new()
    }
}

impl TrustedKeySet {
    /// An empty set with the default K = 5 window.
    pub fn new() -> Self {
        Self { keys: Vec::new(), max_size: DEFAULT_TRUSTED_SET_SIZE }
    }

    /// An empty set with an explicit window size (`0` means unbounded).
    pub fn with_max_size(max_size: usize) -> Self {
        Self { keys: Vec::new(), max_size }
    }

    /// Trust `kid`'s key, given as base64 (standard, padded) X.509 SPKI DER for `alg`.
    /// The key material is validated eagerly (bad key → [`LicenseError::BadPublicKey`]
    /// at load, not at verify). Re-inserting an existing `kid` moves it to newest.
    pub fn insert_spki_b64(
        &mut self,
        kid: impl Into<String>,
        alg: SigAlg,
        spki_b64: &str,
    ) -> Result<(), LicenseError> {
        let der = STANDARD
            .decode(spki_b64.trim())
            .map_err(|_| LicenseError::BadPublicKey)?;
        // Validate now so a malformed key can never sit silently in the trusted window.
        match alg {
            SigAlg::Es256 => {
                p256_key_from_spki(&der)?;
            }
            SigAlg::EdDsa => {
                ed25519_key_from_spki(&der)?;
            }
        }
        self.insert(TrustedKey { kid: kid.into(), alg, public_key: der });
        Ok(())
    }

    /// Insert a pre-built [`TrustedKey`], rolling the oldest off if over capacity.
    pub fn insert(&mut self, key: TrustedKey) {
        self.keys.retain(|k| k.kid != key.kid); // a re-inserted kid rolls to newest
        self.keys.push(key);
        if self.max_size > 0 && self.keys.len() > self.max_size {
            let overflow = self.keys.len() - self.max_size;
            self.keys.drain(0..overflow);
        }
    }

    /// The trusted key for `kid` — its public half **and its pinned algorithm** — or
    /// `None` if unknown / rolled off.
    pub fn get(&self, kid: &str) -> Option<&TrustedKey> {
        self.keys.iter().find(|k| k.kid == kid)
    }

    /// Number of trusted keys currently in the window.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// Whether the window is empty.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// A license whose signature verified and whose claims passed validation. This is a
/// *parsed view* returned only after the signature checked out over the exact received
/// bytes — it is never re-serialized. `max_devices` is advisory (the real cap is at
/// issuance); `exp` is `None` for a perpetual license.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedLicense {
    pub license_id: String,
    pub sub: String,
    pub skill_id: String,
    pub version_constraint: String,
    pub entitlement: String,
    /// Present and carried through, but **never** re-derived/compared offline (ADR-001, §13.12).
    pub device_id: String,
    pub device_binding: Option<String>,
    pub max_devices: i64,
    pub iat: i64,
    pub exp: Option<i64>,
    pub iss: String,
    /// The `kid` whose trusted key verified this license.
    pub kid: String,
    /// The algorithm pinned to that `kid` (the one actually used to verify).
    pub alg: SigAlg,
}

/// Why an offline license failed verification.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LicenseError {
    #[error("not a compact JWS (expected non-empty header.payload.signature)")]
    MalformedToken,
    #[error("license header is not valid base64url-encoded JSON")]
    MalformedHeader,
    #[error("license payload is not valid base64url-encoded JSON")]
    MalformedPayload,
    #[error("unexpected header typ (want '{}')", LICENSE_TYP)]
    UnexpectedTyp,
    #[error("license header is missing a string `kid`")]
    MissingKid,
    #[error("`kid` is not in the trusted-key set (unknown or rolled off)")]
    UnknownKid,
    #[error("insecure or absent header `alg` (`none` is never accepted)")]
    InsecureAlg,
    #[error("alg-confusion: header alg '{header_alg}' != pinned alg {pinned:?} for this kid")]
    AlgConfusion { header_alg: String, pinned: SigAlg },
    #[error("signature segment is malformed or not {} bytes", SIGNATURE_LEN)]
    MalformedSignature,
    #[error("trusted key is not a valid X.509 SPKI public key for its pinned algorithm")]
    BadPublicKey,
    #[error("signature did not verify against the trusted key (tampered or forged)")]
    BadSignature,
    #[error("license claims failed validation: {reason}")]
    InvalidClaims { reason: String },
}

/// Verify a compact license JWS against the trusted-key set, entirely offline.
///
/// The algorithm is pinned per `kid` by `keys` — the token header's `alg` is checked
/// against it and never chooses it. On success the signature has verified over the exact
/// received `header.payload` ASCII bytes and the claims passed validation.
pub fn verify_license(
    compact_jws: &str,
    keys: &TrustedKeySet,
) -> Result<VerifiedLicense, LicenseError> {
    let parts: Vec<&str> = compact_jws.split('.').collect();
    if parts.len() != 3 || parts[0].is_empty() || parts[1].is_empty() || parts[2].is_empty() {
        return Err(LicenseError::MalformedToken);
    }

    // 1. Parse the protected header (untrusted until the signature checks out, but we
    //    need its `kid` to select the pinned key and its `alg` for the confusion check).
    let header = decode_json_segment(parts[0]).ok_or(LicenseError::MalformedHeader)?;
    if header.get("typ").and_then(Value::as_str) != Some(LICENSE_TYP) {
        return Err(LicenseError::UnexpectedTyp); // the format field
    }
    let kid = header
        .get("kid")
        .and_then(Value::as_str)
        .ok_or(LicenseError::MissingKid)?;

    // 2. Pin the algorithm to the trusted key for this kid — the header never chooses it.
    let trusted = keys.get(kid).ok_or(LicenseError::UnknownKid)?;
    let pinned = trusted.alg;

    // 3. Alg-confusion defense, BEFORE touching the signature: the header alg must be
    //    present, not `none`, and equal to the pinned alg. Fail closed on any mismatch.
    match header.get("alg").and_then(Value::as_str) {
        None => return Err(LicenseError::InsecureAlg),
        Some(a) if a.eq_ignore_ascii_case("none") => return Err(LicenseError::InsecureAlg),
        Some(a) if a != pinned.jws_name() => {
            return Err(LicenseError::AlgConfusion { header_alg: a.to_string(), pinned })
        }
        Some(_) => {}
    }

    // 4. Verify the signature over the EXACT received bytes — never a re-encoding.
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let sig = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| LicenseError::MalformedSignature)?;
    match pinned {
        SigAlg::Es256 => verify_es256(&trusted.public_key, signing_input.as_bytes(), &sig)?,
        SigAlg::EdDsa => verify_eddsa(&trusted.public_key, signing_input.as_bytes(), &sig)?,
    }

    // 5. Only now is the payload trusted enough to parse and validate.
    let payload = decode_json_segment(parts[1]).ok_or(LicenseError::MalformedPayload)?;
    build_verified_license(&payload, kid, pinned)
}

/// Verify an ES256 (ECDSA P-256 / SHA-256) signature: `sig` is the fixed 64-byte `R||S`
/// (RFC 7518 §3.4). Exposed at crate level so the golden-vector test can pin the raw
/// primitive cross-language.
pub(crate) fn verify_es256(
    spki: &[u8],
    message: &[u8],
    sig: &[u8],
) -> Result<(), LicenseError> {
    let key = p256_key_from_spki(spki)?;
    if sig.len() != SIGNATURE_LEN {
        return Err(LicenseError::MalformedSignature);
    }
    let signature = P256Signature::from_slice(sig).map_err(|_| LicenseError::MalformedSignature)?;
    key.verify(message, &signature).map_err(|_| LicenseError::BadSignature)
}

/// Verify an Ed25519 (`EdDSA`) signature with `verify_strict` (rejects non-canonical
/// signatures and small-order keys), mirroring `package_verify`.
pub(crate) fn verify_eddsa(
    spki: &[u8],
    message: &[u8],
    sig: &[u8],
) -> Result<(), LicenseError> {
    let key = ed25519_key_from_spki(spki)?;
    let bytes: [u8; SIGNATURE_LEN] = sig
        .try_into()
        .map_err(|_| LicenseError::MalformedSignature)?;
    let signature = Ed25519Signature::from_bytes(&bytes);
    key.verify_strict(message, &signature)
        .map_err(|_| LicenseError::BadSignature)
}

/// Parse an EC P-256 public key from its X.509 SPKI DER bytes (26-byte prefix + 65-byte
/// uncompressed SEC1 point), without a full DER parser.
fn p256_key_from_spki(spki: &[u8]) -> Result<P256VerifyingKey, LicenseError> {
    if spki.len() != P256_SPKI_LEN || spki[..P256_SPKI_PREFIX.len()] != P256_SPKI_PREFIX {
        return Err(LicenseError::BadPublicKey);
    }
    P256VerifyingKey::from_sec1_bytes(&spki[P256_SPKI_PREFIX.len()..])
        .map_err(|_| LicenseError::BadPublicKey)
}

/// Parse an Ed25519 public key from its X.509 SPKI DER bytes (12-byte prefix + 32-byte key).
fn ed25519_key_from_spki(spki: &[u8]) -> Result<Ed25519VerifyingKey, LicenseError> {
    if spki.len() != ED25519_SPKI_LEN || spki[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX {
        return Err(LicenseError::BadPublicKey);
    }
    let mut raw = [0u8; ED25519_RAW_LEN];
    raw.copy_from_slice(&spki[ED25519_SPKI_PREFIX.len()..]);
    Ed25519VerifyingKey::from_bytes(&raw).map_err(|_| LicenseError::BadPublicKey)
}

/// base64url-decode a JWS segment and parse it as a JSON object.
fn decode_json_segment(seg: &str) -> Option<Map<String, Value>> {
    let bytes = URL_SAFE_NO_PAD.decode(seg).ok()?;
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// Validate the license claims and assemble the [`VerifiedLicense`]. Called only after
/// the signature verified. Mirrors the backend `LicenseVerifier` field checks: pinned
/// issuer + entitlement, `exp:null`, and the required binding fields present.
fn build_verified_license(
    p: &Map<String, Value>,
    kid: &str,
    alg: SigAlg,
) -> Result<VerifiedLicense, LicenseError> {
    if req_str(p, "iss")? != EXPECTED_ISSUER {
        return Err(invalid("unexpected issuer"));
    }
    if req_str(p, "entitlement")? != EXPECTED_ENTITLEMENT {
        return Err(invalid("entitlement must be 'perpetual'"));
    }
    // A perpetual license must carry `exp:null` (or omit it); any real expiry is a forgery signal.
    match p.get("exp") {
        None | Some(Value::Null) => {}
        Some(_) => return Err(invalid("perpetual license must carry exp:null")),
    }

    let license_id = req_str(p, "license_id")?;
    let sub = req_str(p, "sub")?;
    let skill_id = req_str(p, "skill_id")?;
    let version_constraint = req_str(p, "version_constraint")?; // the version field
    // `device_id` MUST be present, but we NEVER re-derive or compare a device fingerprint
    // offline (ADR-001, SPEC §13.12) — binding is enforced at issuance, not here.
    let device_id = req_str(p, "device_id")?;
    let device_binding = p
        .get("device_binding")
        .and_then(Value::as_str)
        .map(str::to_string);
    let max_devices = p.get("max_devices").and_then(Value::as_i64).unwrap_or(0);
    let iat = p.get("iat").and_then(Value::as_i64).unwrap_or(0);

    Ok(VerifiedLicense {
        license_id,
        sub,
        skill_id,
        version_constraint,
        entitlement: EXPECTED_ENTITLEMENT.to_string(),
        device_id,
        device_binding,
        max_devices,
        iat,
        exp: None,
        iss: EXPECTED_ISSUER.to_string(),
        kid: kid.to_string(),
        alg,
    })
}

/// A required non-empty string claim, or an [`LicenseError::InvalidClaims`] naming it.
fn req_str(p: &Map<String, Value>, field: &str) -> Result<String, LicenseError> {
    match p.get(field).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(invalid(format!("missing or non-string claim '{field}'"))),
    }
}

fn invalid(reason: impl Into<String>) -> LicenseError {
    LicenseError::InvalidClaims { reason: reason.into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The cross-language golden vector: a real ES256 license JWS the backend minted.
    #[derive(serde::Deserialize)]
    struct GoldenVector {
        token: String,
        signing_input: String,
        public_key_spki_b64: String,
        kid: String,
    }

    fn golden() -> GoldenVector {
        let raw = include_str!("../../../contracts/testdata/license-es256-golden.json");
        serde_json::from_str(raw).expect("golden license vector parses")
    }

    /// A trusted set with only the golden ES256 key pinned.
    fn golden_trust() -> TrustedKeySet {
        let g = golden();
        let mut set = TrustedKeySet::new();
        set.insert_spki_b64(g.kid.clone(), SigAlg::Es256, &g.public_key_spki_b64)
            .expect("golden ES256 SPKI is valid");
        set
    }

    /// Replace a token's header segment with a fresh JSON header (payload + sig kept).
    fn reheader(token: &str, header: Value) -> String {
        let parts: Vec<&str> = token.split('.').collect();
        let h = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
        format!("{}.{}.{}", h, parts[1], parts[2])
    }

    /// Build the base64 X.509 SPKI for a raw Ed25519 public key.
    fn eddsa_spki_b64(raw: &[u8; 32]) -> String {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(raw);
        STANDARD.encode(der)
    }

    // --- THE cross-language gate -------------------------------------------

    /// End-to-end: the golden ES256 license JWS verifies and yields the exact claims.
    #[test]
    fn es256_golden_license_verifies_end_to_end() {
        let g = golden();
        let set = golden_trust();
        let vl = verify_license(&g.token, &set).expect("golden license must verify");
        assert_eq!(vl.license_id, "lic_golden_es256");
        assert_eq!(vl.sub, "user_golden");
        assert_eq!(vl.skill_id, "cooking-assistant");
        assert_eq!(vl.version_constraint, ">=1.0.0");
        assert_eq!(vl.entitlement, "perpetual");
        assert_eq!(vl.device_id, "dev_golden");
        assert_eq!(vl.device_binding.as_deref(), Some("fp-golden-coarse"));
        assert_eq!(vl.max_devices, 5);
        assert_eq!(vl.iat, 1770000000);
        assert_eq!(vl.exp, None);
        assert_eq!(vl.iss, "hydropark-licensing");
        assert_eq!(vl.kid, "hp-lic-es256-golden");
        assert_eq!(vl.alg, SigAlg::Es256);
    }

    /// The raw P-256/SHA-256 tie: the signature verifies over the vector's exact signed
    /// bytes, and a one-bit change to those bytes breaks it. This pins the primitive to
    /// the backend independently of the JWS envelope.
    #[test]
    fn es256_golden_raw_signature_matches_backend_byte_for_byte() {
        let g = golden();
        let spki = STANDARD.decode(g.public_key_spki_b64.trim()).unwrap();
        let sig_b64 = g.token.split('.').nth(2).unwrap();
        let sig = URL_SAFE_NO_PAD.decode(sig_b64).unwrap();
        assert_eq!(sig.len(), SIGNATURE_LEN, "JWS ES256 sig must be raw 64-byte R||S");
        assert_eq!(verify_es256(&spki, g.signing_input.as_bytes(), &sig), Ok(()));

        let mut tampered = g.signing_input.clone().into_bytes();
        *tampered.last_mut().unwrap() ^= 0x01;
        assert_eq!(
            verify_es256(&spki, &tampered, &sig),
            Err(LicenseError::BadSignature)
        );
    }

    // --- negative: tamper, alg none, alg confusion, unknown kid ------------

    /// A tampered payload (re-encoded valid JSON, but no longer the signed bytes) is rejected.
    #[test]
    fn tampered_payload_is_rejected() {
        let g = golden();
        let set = golden_trust();
        let parts: Vec<&str> = g.token.split('.').collect();
        let mut payload: Map<String, Value> =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        // Swap in a different skill_id — a signature over the original must no longer match.
        payload.insert("skill_id".into(), Value::String("smuggled-skill".into()));
        let forged_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let forged = format!("{}.{}.{}", parts[0], forged_payload, parts[2]);
        assert_eq!(verify_license(&forged, &set), Err(LicenseError::BadSignature));
    }

    /// Header `alg: none` is rejected outright (never trust an unsigned token).
    #[test]
    fn header_alg_none_is_rejected() {
        let g = golden();
        let set = golden_trust();
        let forged = reheader(
            &g.token,
            json!({"alg": "none", "kid": "hp-lic-es256-golden", "typ": "hp-lic+jws"}),
        );
        assert_eq!(verify_license(&forged, &set), Err(LicenseError::InsecureAlg));
    }

    /// Header claims `EdDSA` but the pinned kid is `Es256` → alg-confusion, rejected
    /// before the signature is even touched.
    #[test]
    fn alg_confusion_eddsa_header_over_es256_kid_is_rejected() {
        let g = golden();
        let set = golden_trust();
        let forged = reheader(
            &g.token,
            json!({"alg": "EdDSA", "kid": "hp-lic-es256-golden", "typ": "hp-lic+jws"}),
        );
        match verify_license(&forged, &set) {
            Err(LicenseError::AlgConfusion { header_alg, pinned }) => {
                assert_eq!(header_alg, "EdDSA");
                assert_eq!(pinned, SigAlg::Es256);
            }
            other => panic!("expected AlgConfusion, got {other:?}"),
        }
    }

    /// An unknown / untrusted `kid` is rejected (empty set, and a set trusting a *different* kid).
    #[test]
    fn unknown_kid_is_rejected() {
        let g = golden();
        assert_eq!(
            verify_license(&g.token, &TrustedKeySet::new()),
            Err(LicenseError::UnknownKid)
        );
        let mut other = TrustedKeySet::new();
        other
            .insert_spki_b64("some-other-kid", SigAlg::Es256, &g.public_key_spki_b64)
            .unwrap();
        assert_eq!(verify_license(&g.token, &other), Err(LicenseError::UnknownKid));
    }

    /// Structurally broken tokens are rejected before any crypto.
    #[test]
    fn malformed_tokens_are_rejected() {
        let set = golden_trust();
        assert_eq!(verify_license("only.two", &set), Err(LicenseError::MalformedToken));
        assert_eq!(verify_license("a..c", &set), Err(LicenseError::MalformedToken));
        assert_eq!(verify_license("", &set), Err(LicenseError::MalformedToken));
    }

    /// A wrong header `typ` (not `hp-lic+jws`) is rejected as a format-field failure.
    #[test]
    fn wrong_typ_is_rejected() {
        let g = golden();
        let set = golden_trust();
        let forged = reheader(
            &g.token,
            json!({"alg": "ES256", "kid": "hp-lic-es256-golden", "typ": "jwt"}),
        );
        assert_eq!(verify_license(&forged, &set), Err(LicenseError::UnexpectedTyp));
    }

    /// A structurally invalid SPKI is rejected at insert time, not at verify.
    #[test]
    fn bad_public_key_is_rejected_at_insert() {
        let mut set = TrustedKeySet::new();
        assert_eq!(
            set.insert_spki_b64("k", SigAlg::Es256, "AAAA"),
            Err(LicenseError::BadPublicKey)
        );
        assert_eq!(
            set.insert_spki_b64("k", SigAlg::EdDsa, "%%%not base64%%%"),
            Err(LicenseError::BadPublicKey)
        );
    }

    // --- rolling window + both key classes (EdDSA minted in-test) -----------

    /// The set holds both an `EdDSA` and an `ES256` key at once (both verify), and the
    /// K = 5 window rolls the oldest keys off as newer ones are inserted.
    #[test]
    fn trusted_set_holds_both_classes_and_rolls_at_capacity() {
        use ed25519_dalek::{Signer, SigningKey};

        // Mint a deterministic EdDSA license purely in-test (no network, no model).
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk = sk.verifying_key();
        let ed_spki = eddsa_spki_b64(&vk.to_bytes());
        let ed_kid = "hp-lic-ed25519-test";
        let header = json!({"alg": "EdDSA", "kid": ed_kid, "typ": "hp-lic+jws"});
        let payload = json!({
            "license_id": "lic_ed", "sub": "user_ed", "skill_id": "cooking-assistant",
            "version_constraint": ">=1.0.0", "entitlement": "perpetual", "device_id": "dev_ed",
            "device_binding": "fp-ed", "max_devices": 5, "iat": 1770000000, "exp": null,
            "iss": "hydropark-licensing"
        });
        let h = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
        let p = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signing_input = format!("{h}.{p}");
        let sig = sk.sign(signing_input.as_bytes());
        let ed_token = format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));

        let g = golden();
        let mut set = TrustedKeySet::new();
        set.insert_spki_b64(ed_kid, SigAlg::EdDsa, &ed_spki).unwrap();
        set.insert_spki_b64(g.kid.clone(), SigAlg::Es256, &g.public_key_spki_b64)
            .unwrap();
        assert_eq!(set.len(), 2);

        // Both classes verify while trusted.
        assert!(verify_license(&ed_token, &set).is_ok());
        assert!(verify_license(&g.token, &set).is_ok());

        // Five more inserts roll the two oldest (the EdDSA + ES256 golden) off the K=5 window.
        for i in 0..5 {
            set.insert_spki_b64(format!("filler-{i}"), SigAlg::Es256, &g.public_key_spki_b64)
                .unwrap();
        }
        assert_eq!(set.len(), 5);
        assert_eq!(verify_license(&ed_token, &set), Err(LicenseError::UnknownKid));
    }

    /// The pinned algorithm's JWS name is exactly what the header must present.
    #[test]
    fn sig_alg_jws_names() {
        assert_eq!(SigAlg::Es256.jws_name(), "ES256");
        assert_eq!(SigAlg::EdDsa.jws_name(), "EdDSA");
    }
}
