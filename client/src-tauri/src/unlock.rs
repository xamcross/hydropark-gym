//! Hydropark Phase-0 receipt/unlock redemption (P0-05.5) — Rust core side.
//!
//!   >> THROWAWAY VALIDATION PROTOTYPE. This is NOT the production licensing
//!      system (SPEC §13 / BACKEND-DESIGN §6: server-issued Ed25519 licences +
//!      device binding). It is the weakest thing that clears "not a length
//!      check" for the H3 paid smoke test, and is meant to be thrown away
//!      (PHASE0-PLAN §0/§4c). <<
//!
//! The buyer pays on the hosted checkout, the fulfillment stub emails them a
//! one-time code, and this module VERIFIES that code and PERSISTS the unlock so
//! the paid Cooking Assistant stays enabled across restarts. The scheme (an
//! HMAC-SHA256 tag over a random nonce, keyed by a shared secret baked into the
//! client) is documented in full in `fulfillment/unlock_codes.py` — this file is
//! its Rust mirror and MUST agree byte-for-byte with that and with
//! `client/web/src/app/unlock/unlock-code.ts`.
//!
//! Why the secret is symmetric and shipped in the client (and why that is fine
//! here but never in production): see the fulfillment header. Anyone who unpacks
//! the app can mint codes; this only deters casual sharing during a short test.
//!
//! ── Ownership note ─────────────────────────────────────────────────────────
//! SHA-256 + HMAC are vendored below (≈120 lines, standard FIPS-180-4 / RFC-2104)
//! ON PURPOSE: it keeps this module dependency-free so adding it needs NO edit to
//! `Cargo.toml` (which another agent may be editing concurrently) and no new
//! crate to reconcile. Production would use a vetted crate (`sha2`/`hmac`), not
//! this. Like the rest of this crate it is authored but not compiled in this
//! environment (see client/README.md); the `#[cfg(test)]` vector at the bottom
//! pins the exact bytes the Python/TS sides already produce, so a first real
//! `cargo test` proves cross-language agreement.
//!
//! ── Registration (hand-off for the lead — see report) ──────────────────────
//! Add `mod unlock;` beside the other `mod` lines in `main.rs`, and add
//! `unlock::unlock_redeem, unlock::unlock_status` to the `generate_handler!`
//! list. No `.manage()` state is needed — the commands resolve the app-data dir
//! from the `AppHandle` themselves (same pattern as `notify`/telemetry).
//!
//! ── P1 purchase reconciliation seam (paid-enable dashboard bug) ────────────
//! A Marketplace purchase of `cooking-assistant` goes through a COMPLETELY
//! SEPARATE ownership model — checkout -> settle -> license ->
//! `skill_download_install` (P1-08.x / hpskill.rs), which caches ownership in
//! the on-device `Store`'s entitlements/installed_skills tables. It never used
//! to touch THIS module's gate, so a purchased Cooking Assistant showed
//! "owned" on the Marketplace detail (P1 model) but stayed "Locked" on the
//! Assistant dashboard and never composed (P0 model, gated on
//! `skills::cooking_assistant::gate()`, flipped only by `unlock_redeem` below).
//! [`mark_unlocked_via_purchase`] is the ONE seam that reconciles them: called
//! from `main.rs`'s `skill_download_install` the moment it successfully
//! installs `cooking-assistant` (which only happens after the P1 pipeline's own
//! `is_entitled` ownership check already passed — this is not a new trust
//! decision, just propagating an existing one to the P0 gate). Angular's
//! matching half lives in `PurchaseService.enable()`
//! (`client/web/src/app/marketplace/purchase.service.ts`), which re-hydrates
//! `UnlockService` from `unlock_status` right after, instead of the old
//! `!isTauriRuntime()`-gated `devSimulateUnlock()` call that never actually
//! reached a real Tauri build.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Scheme constants — IDENTICAL to unlock_codes.py / unlock-code.ts
// ---------------------------------------------------------------------------

/// Shared secret. Throwaway; baked into the client. See module docs.
const SHARED_SECRET: &[u8] = b"hp0-unlock-shared-secret::throwaway::not-a-license-key";

const SIGN_PREFIX: &str = "HP0";
const PRODUCT: &str = "cooking-assistant";
/// The one paid Phase-0 SKU this code unlocks. Mirrors `SkillId::CookingAssistant`.
pub const COOKING_ASSISTANT_SKILL_ID: &str = "cooking-assistant";

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford (no I L O U)
const TAG_BYTES: usize = 10; //  -> 16 base32 chars
const CANON_LEN: usize = 5 + 8 + 16; // "HP0CA" + nonce8 + tag16

// ---------------------------------------------------------------------------
// Public API used by the skills module (seam) and the commands
// ---------------------------------------------------------------------------

/// Whether the paid Cooking Assistant has been unlocked on this machine.
///
/// THIS IS THE SEAM the skills work reads: `cooking_assistant::is_unlocked()`
/// (referenced in cooking-assistant.service.ts's comment) should return this,
/// so there is one persisted source of truth for the paid gate.
pub fn is_cooking_assistant_unlocked(app: &AppHandle) -> bool {
    read_state(app).cooking_assistant.unlocked
}

/// Verify a user-entered code: structurally valid AND correctly signed for this
/// SKU under `SHARED_SECRET`. The app's verification routine (mirrors verify()
/// in unlock_codes.py / verifyUnlockCode in unlock-code.ts).
pub fn verify(user_input: &str) -> VerifyOutcome {
    let s = canonicalize(user_input);
    if s.len() != CANON_LEN || !s.starts_with("HP0CA") {
        return VerifyOutcome::Malformed;
    }
    let nonce8 = &s[5..13];
    let presented = &s[13..29];
    let expected = tag_for(nonce8);
    if ct_eq(presented.as_bytes(), expected.as_bytes()) {
        VerifyOutcome::Valid { nonce: nonce8.to_string() }
    } else {
        VerifyOutcome::BadSignature
    }
}

pub enum VerifyOutcome {
    Valid { nonce: String },
    Malformed,
    BadSignature,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct UnlockRedeemArgs {
    pub code: String,
}

/// Flat result matching `RustRedeemResult` in unlock.service.ts (all optionals
/// omitted when absent). `ok:false` carries a reason/message; genuine errors are
/// still returned as `ok:false` rather than a rejected promise so the webview
/// always gets a structured answer.
#[derive(Debug, Clone, Serialize, Default)]
pub struct RedeemResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>, // "unlocked" | "already_unlocked"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>, // "malformed" | "bad_signature" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnlockStatus {
    pub cooking_assistant_unlocked: bool,
}

/// `invoke('unlock_redeem', { args: { code } })`. Verifies, and on success
/// persists the unlock to `<app-data-dir>/unlock.json` so it survives restarts.
#[tauri::command]
pub fn unlock_redeem(args: UnlockRedeemArgs, app: AppHandle) -> RedeemResult {
    match verify(&args.code) {
        VerifyOutcome::Malformed => RedeemResult {
            ok: false,
            reason: Some("malformed".into()),
            message: Some("That doesn't look like a Hydropark unlock code.".into()),
            ..Default::default()
        },
        VerifyOutcome::BadSignature => RedeemResult {
            ok: false,
            reason: Some("bad_signature".into()),
            message: Some("That code isn't valid — check it against the one in your email.".into()),
            ..Default::default()
        },
        VerifyOutcome::Valid { nonce } => {
            let already = mark_unlocked(&app, Some(nonce));
            RedeemResult {
                ok: true,
                status: Some(if already { "already_unlocked" } else { "unlocked" }.into()),
                skill_id: Some(COOKING_ASSISTANT_SKILL_ID.into()),
                ..Default::default()
            }
        }
    }
}

/// `invoke('unlock_status')`. Read-only; used to hydrate the webview on launch.
#[tauri::command]
pub fn unlock_status(app: AppHandle) -> UnlockStatus {
    UnlockStatus { cooking_assistant_unlocked: is_cooking_assistant_unlocked(&app) }
}

/// Reconcile a COMPLETED P1 marketplace purchase+install of `cooking-assistant`
/// with this module's P0 unlock gate. See the module-level "P1 purchase
/// reconciliation seam" doc above for why this exists; called exactly once,
/// from `main.rs`'s `skill_download_install`, right after
/// `SkillInstaller::install_bytes` succeeds for this skill id.
///
/// No nonce (there is no redeemed code) — `mark_unlocked` leaves any existing
/// one alone, so this can never clobber a real code redemption's record.
pub fn mark_unlocked_via_purchase(app: &AppHandle) {
    mark_unlocked(app, None);
}

/// Shared state transition behind BOTH unlock paths (a redeemed code, or a
/// completed purchase): persist `unlocked: true` to `unlock.json` (best-effort,
/// mirrors the webview's localStorage try/catch — a write hiccup must not fail
/// an otherwise-valid unlock) and refresh the in-session gate cache the
/// synchronous `skill_enable` command reads, so the paid skill works THIS
/// session without a restart. Returns whether it was already unlocked before
/// this call (`already_unlocked` vs. `unlocked` in `RedeemResult`).
fn mark_unlocked(app: &AppHandle, nonce: Option<String>) -> bool {
    let state = read_state(app);
    let (next, already) = apply_unlock(state, nonce);
    let _ = write_state(app, &next);
    crate::skills::cooking_assistant::set_unlocked(true);
    already
}

/// Pure state transition — no I/O, so it's testable without a live `AppHandle`
/// (unlike the rest of this module, which needs the app-data dir). A `None`
/// nonce (the purchase-reconciliation path) preserves whatever nonce, if any,
/// was already recorded rather than clobbering it.
fn apply_unlock(mut state: UnlockState, nonce: Option<String>) -> (UnlockState, bool) {
    let already = state.cooking_assistant.unlocked;
    let nonce = nonce.or_else(|| state.cooking_assistant.nonce.take());
    state.cooking_assistant = SkillUnlock { unlocked: true, nonce, redeemed_at_ms: Some(now_ms()) };
    (state, already)
}

// ---------------------------------------------------------------------------
// Persistence — <app-data-dir>/unlock.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SkillUnlock {
    unlocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    redeemed_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UnlockState {
    #[serde(default)]
    cooking_assistant: SkillUnlock,
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("unlock.json"))
}

fn read_state(app: &AppHandle) -> UnlockState {
    let Some(path) = state_path(app) else { return UnlockState::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => UnlockState::default(), // missing file = nothing unlocked yet
    }
}

fn write_state(app: &AppHandle, state: &UnlockState) -> std::io::Result<()> {
    let path = state_path(app)
        .ok_or_else(|| std::io::Error::other("no app data dir"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::write(&path, json)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Code scheme helpers (canonicalize / tag / base32)
// ---------------------------------------------------------------------------

/// Normalize whatever a human typed (case, spaces, hyphens, O->0, I/L->1) down to
/// the 29 significant chars. Mirrors `canonicalize` in unlock_codes.py.
fn canonicalize(input: &str) -> String {
    let mut out = String::with_capacity(CANON_LEN);
    for ch in input.chars() {
        let c = match ch.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        };
        if ALPHABET.contains(&(c as u8)) {
            out.push(c);
        }
    }
    out
}

fn tag_for(nonce8: &str) -> String {
    let input = format!("{SIGN_PREFIX}|{PRODUCT}|{nonce8}");
    let mac = hmac_sha256(SHARED_SECRET, input.as_bytes());
    b32(&mac[..TAG_BYTES])
}

/// MSB-first Crockford base32, no padding. Mirrors `_b32` in unlock_codes.py.
fn b32(data: &[u8]) -> String {
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = String::new();
    for &byte in data {
        value = (value << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((value >> bits) & 0x1F) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (5 - bits)) & 0x1F) as usize] as char);
    }
    out
}

/// Constant-time equality for two equal-length byte slices.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// Vendored SHA-256 (FIPS 180-4) + HMAC-SHA256 (RFC 2104) — see ownership note.
// Standard, constant tables; not novel. Replace with the `sha2`/`hmac` crates
// on any real hardening pass.
// ---------------------------------------------------------------------------

const SHA256_H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(msg: &[u8]) -> [u8; 32] {
    let mut h = SHA256_H0;

    // Padding: 0x80, then zeros, then 64-bit big-endian bit length -> multiple of 64.
    let mut data = msg.to_vec();
    let bit_len = (msg.len() as u64).wrapping_mul(8);
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    for block in data.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, wi) in w.iter_mut().enumerate().take(16) {
            let j = i * 4;
            *wi = u32::from_be_bytes([block[j], block[j + 1], block[j + 2], block[j + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k0 = [0u8; BLOCK];
    if key.len() > BLOCK {
        k0[..32].copy_from_slice(&sha256(key));
    } else {
        k0[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k0[i];
        opad[i] ^= k0[i];
    }

    let mut inner = Vec::with_capacity(BLOCK + msg.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(msg);
    let inner_hash = sha256(&inner);

    let mut outer = Vec::with_capacity(BLOCK + 32);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha256(&outer)
}

// ---------------------------------------------------------------------------
// Tests — pin the exact cross-language vector produced by unlock_codes.py.
// (Authored, not run here; `cargo test` proves parity on a real build.)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Known-answer vector: nonce bytes [0,1,2,3,4] under SHARED_SECRET.
    // Produced and checked against Python (hashlib) and TS (Web Crypto).
    const VECTOR_CODE: &str = "HP0-CA-000G40R4-P04F-AHYY-XGHJ-H115";

    #[test]
    fn sha256_empty_matches_fips_vector() {
        // FIPS 180-4 empty-string digest.
        let d = sha256(b"");
        let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hmac_sha256_rfc4231_case1() {
        // RFC 4231 test case 1: key=0x0b*20, data="Hi There".
        let key = [0x0bu8; 20];
        let mac = hmac_sha256(&key, b"Hi There");
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn accepts_valid_code_and_reads_nonce() {
        match verify(VECTOR_CODE) {
            VerifyOutcome::Valid { nonce } => assert_eq!(nonce, "000G40R4"),
            _ => panic!("valid code was rejected"),
        }
    }

    #[test]
    fn tolerates_messy_input() {
        assert!(matches!(
            verify("  hp0 ca 000g40r4 p04f ahyy xghj h115 "),
            VerifyOutcome::Valid { .. }
        ));
    }

    #[test]
    fn rejects_tampered_and_garbage() {
        // Flip the last tag char.
        assert!(matches!(verify("HP0-CA-000G40R4-P04F-AHYY-XGHJ-H11Z"), VerifyOutcome::BadSignature));
        assert!(matches!(verify("hunter2"), VerifyOutcome::Malformed));
        assert!(matches!(verify(""), VerifyOutcome::Malformed));
    }

    // ── apply_unlock — the pure state transition behind BOTH unlock paths ────
    // (a redeemed code AND, since the paid-enable/dashboard-lock bug fix, a
    // completed marketplace purchase). No AppHandle needed, unlike the rest of
    // this module, so these run as plain `cargo test`.

    #[test]
    fn apply_unlock_marks_unlocked_and_reports_not_already() {
        let (next, already) = apply_unlock(UnlockState::default(), Some("N0NCE001".into()));
        assert!(!already);
        assert!(next.cooking_assistant.unlocked);
        assert_eq!(next.cooking_assistant.nonce.as_deref(), Some("N0NCE001"));
        assert!(next.cooking_assistant.redeemed_at_ms.is_some());
    }

    #[test]
    fn apply_unlock_on_an_already_unlocked_state_reports_already_true() {
        let (first, _) = apply_unlock(UnlockState::default(), Some("N0NCE001".into()));
        let (second, already) = apply_unlock(first, Some("N0NCE001".into()));
        assert!(already);
        assert!(second.cooking_assistant.unlocked);
    }

    /// The purchase-reconciliation path (`mark_unlocked_via_purchase`) calls
    /// `apply_unlock` with `nonce: None` — it must never clobber a real
    /// redeemed code's nonce that was already on record.
    #[test]
    fn apply_unlock_with_no_nonce_preserves_an_existing_one() {
        let (redeemed, _) = apply_unlock(UnlockState::default(), Some("REAL-CODE".into()));
        let (reconciled, already) = apply_unlock(redeemed, None);
        assert!(already);
        assert_eq!(reconciled.cooking_assistant.nonce.as_deref(), Some("REAL-CODE"));
    }

    /// The purchase-only path: no code was ever redeemed, so there is no nonce
    /// to preserve — `unlocked` still flips true (this is the bug-fix case:
    /// P1 marketplace ownership, not a code, is what's unlocking the gate).
    #[test]
    fn apply_unlock_with_no_nonce_on_a_fresh_state_still_unlocks() {
        let (next, already) = apply_unlock(UnlockState::default(), None);
        assert!(!already);
        assert!(next.cooking_assistant.unlocked);
        assert!(next.cooking_assistant.nonce.is_none());
    }
}
