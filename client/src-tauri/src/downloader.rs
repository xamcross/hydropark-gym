#![allow(dead_code)] // Phase-1 model download manager; the webview download UI + a live host are a later ticket.

//! Model download manager (P1-02.7, SPEC §6 / §13.8).
//!
//! Streams a GGUF model file to the on-device app-data dir, then **signature-verifies
//! it before it is ever accepted** by the inference engine. The trust model mirrors
//! [`crate::package_verify`]: the finished file's SHA-256 is checked against the
//! expected digest, and a detached **Ed25519 signature over that 32-byte digest** is
//! verified against a pinned trusted-key set (§13.8) — so a corrupt, truncated, or
//! swapped model can never be loaded, entirely offline once the bytes are on disk.
//!
//! The transport supports **HTTP Range resume** (a partially-downloaded `.part` file
//! continues from where it left off) and an optional **delta manifest** (fetch only the
//! parts a resume/patch still needs instead of one blob).
//!
//! ## Testability
//! No live model host is configured in this environment, so the network-touching parts
//! (the actual `reqwest` streaming) are NOT unit-tested. Instead the logic that governs
//! them is factored into **pure helpers** — URL building ([`join_url`]/[`part_url`]),
//! range math ([`range_header`]), the resume decision ([`resume_decision`]), delta-part
//! selection ([`parts_to_fetch`]/[`validate_parts`]), and digest+signature verification
//! ([`file_digest`]/[`verify_model`]) — and THOSE are unit-tested (no sockets). The
//! `async` download driver is a thin wrapper that calls them.
//!
//! ── Registration ───────────────────────────────────────────────────────────
//! `mod downloader;` is declared in `main.rs`; the [`DownloadManager`] is `.manage()`-d
//! there and the three commands (`model_download_start` / `_status` / `_cancel`) are
//! registered in `generate_handler!`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ipc::{
    CmdError, ModelDeltaPart, ModelDownloadPhase, ModelDownloadProgressEvent,
    ModelDownloadStartArgs, ModelDownloadStatus,
};

// ---------------------------------------------------------------------------
// Trust constants (mirror `package_verify` — a model is trusted the same way a
// package manifest is: an Ed25519 signature over a fixed byte string, here the
// file's SHA-256 digest rather than a JCS-canonical manifest).
// ---------------------------------------------------------------------------

/// Wire prefix on a detached signature string (`ed25519:<base64>`).
const SIGNATURE_PREFIX: &str = "ed25519:";

/// The fixed 12-byte DER prefix of an X.509 SubjectPublicKeyInfo wrapping an Ed25519
/// key (OID 1.3.101.112); a full SPKI is this prefix + the 32-byte raw key (44 bytes).
/// Identical to `package_verify`'s constant — parsing just this shape avoids a full
/// DER parser.
const ED25519_SPKI_PREFIX: [u8; 12] =
    [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// Total byte length of an Ed25519 X.509 SPKI: 12-byte prefix + 32-byte key.
const ED25519_SPKI_LEN: usize = ED25519_SPKI_PREFIX.len() + 32;

/// Length of a raw Ed25519 signature.
const SIGNATURE_LEN: usize = 64;

/// Emit a progress event at most this often, by bytes, so a fast link does not flood
/// the webview with one event per network chunk.
const PROGRESS_STRIDE_BYTES: u64 = 4 * 1024 * 1024;

/// Env var carrying the pinned model-signing trusted keys, as `kid=spkiB64` pairs
/// separated by `;` (or `,`). Empty/unset ⇒ no trusted key ⇒ every verify fails closed.
const TRUSTED_KEYS_ENV: &str = "HYDROPARK_MODEL_SIGNING_KEYS";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why a finished model file failed verification (mirrors [`crate::package_verify`]'s
/// `PackageVerifyError`, but over the file's SHA-256 digest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelVerifyError {
    /// The finished file's SHA-256 does not match the expected digest (corrupt/truncated).
    DigestMismatch,
    /// The `signature` is not `ed25519:<base64>` decoding to 64 bytes.
    MalformedSignature,
    /// The `signing_key_id` is not in the trusted-key set.
    UnknownKid,
    /// A trusted-key entry was not a valid 44-byte Ed25519 X.509 SPKI key.
    BadPublicKey,
    /// The signature did not verify against the trusted key (tampered / forged).
    SignatureMismatch,
}

impl std::fmt::Display for ModelVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelVerifyError::DigestMismatch => {
                write!(f, "downloaded file's SHA-256 does not match the expected digest")
            }
            ModelVerifyError::MalformedSignature => {
                write!(f, "signature is not `ed25519:<base64>` decoding to {SIGNATURE_LEN} bytes")
            }
            ModelVerifyError::UnknownKid => {
                write!(f, "signing_key_id is not in the trusted-key set")
            }
            ModelVerifyError::BadPublicKey => {
                write!(f, "trusted key is not a valid Ed25519 X.509 SPKI public key")
            }
            ModelVerifyError::SignatureMismatch => {
                write!(f, "model signature did not verify against the trusted key")
            }
        }
    }
}

impl std::error::Error for ModelVerifyError {}

/// Anything that can go wrong running a download to completion.
#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("network error: {0}")]
    Network(String),
    #[error("backend returned HTTP {status}")]
    Status { status: u16 },
    #[error("io error: {0}")]
    Io(String),
    #[error("invalid delta manifest: {0}")]
    Manifest(String),
    #[error("verification failed: {0}")]
    Verify(#[from] ModelVerifyError),
    #[error("download cancelled")]
    Cancelled,
}

impl From<DownloadError> for CmdError {
    fn from(e: DownloadError) -> Self {
        CmdError::Download(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Pure helper: URL building
// ---------------------------------------------------------------------------

/// Join a base and a relative path with exactly one `/` between them, tolerating a
/// trailing slash on the base and/or a leading slash on the path (mirrors
/// `backend_client::join`).
pub fn join_url(base: &str, rel: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), rel.trim_start_matches('/'))
}

/// The absolute URL for a delta-manifest part, resolved against the download base.
/// An absolute part path (already `http(s)://…`) is used verbatim.
pub fn part_url(base: &str, part_path: &str) -> String {
    if part_path.starts_with("http://") || part_path.starts_with("https://") {
        part_path.to_string()
    } else {
        join_url(base, part_path)
    }
}

// ---------------------------------------------------------------------------
// Pure helper: range math + resume decision
// ---------------------------------------------------------------------------

/// The `Range` request-header value that resumes a download from `offset` to the end.
pub fn range_header(offset: u64) -> String {
    format!("bytes={offset}-")
}

/// How to proceed given the bytes already on disk vs. the known total.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeDecision {
    /// Nothing on disk (or the total is unknown) — download the whole file from 0.
    Fresh,
    /// A partial file is on disk — request `bytes=offset-` and append.
    Resume { offset: u64 },
    /// The file on disk is already the full size — nothing to download.
    Complete,
    /// The file on disk is larger than the total (stale/corrupt) — discard, start over.
    Restart,
}

/// Decide how to continue a download. `total == 0` means "size unknown", which forces a
/// fresh download (we cannot reason about resume without the target size).
pub fn resume_decision(local_bytes: u64, total_bytes: u64) -> ResumeDecision {
    if total_bytes == 0 {
        return ResumeDecision::Fresh;
    }
    match local_bytes {
        0 => ResumeDecision::Fresh,
        l if l == total_bytes => ResumeDecision::Complete,
        l if l < total_bytes => ResumeDecision::Resume { offset: l },
        _ => ResumeDecision::Restart,
    }
}

// ---------------------------------------------------------------------------
// Pure helper: delta-manifest part selection
// ---------------------------------------------------------------------------

/// Validate that the parts tile `[0, total_bytes)` exactly: sorted by offset, each part
/// starting where the previous ended, with no gaps or overlaps and covering the whole
/// file. Returns a human error otherwise.
pub fn validate_parts(parts: &[ModelDeltaPart], total_bytes: u64) -> Result<(), String> {
    if parts.is_empty() {
        return Err("delta manifest has no parts".to_string());
    }
    let mut cursor: u64 = 0;
    for (i, p) in parts.iter().enumerate() {
        if p.offset != cursor {
            return Err(format!(
                "part {i} starts at offset {} but expected {cursor} (gap or overlap)",
                p.offset
            ));
        }
        cursor = p
            .offset
            .checked_add(p.size)
            .ok_or_else(|| format!("part {i} offset+size overflows"))?;
    }
    if cursor != total_bytes {
        return Err(format!("parts cover {cursor} bytes but total is {total_bytes}"));
    }
    Ok(())
}

/// The delta step: given how many contiguous bytes we already have on disk, the parts
/// still (wholly or partly) needed. A part fully below `have_bytes` is skipped.
pub fn parts_to_fetch(parts: &[ModelDeltaPart], have_bytes: u64) -> Vec<&ModelDeltaPart> {
    parts.iter().filter(|p| p.offset + p.size > have_bytes).collect()
}

/// The largest clean part boundary at or below `have_bytes` — the byte count to keep
/// when resuming a delta download, discarding any half-written trailing part.
pub fn part_resume_boundary(parts: &[ModelDeltaPart], have_bytes: u64) -> u64 {
    let mut boundary = 0;
    for p in parts {
        let end = p.offset + p.size;
        if end <= have_bytes {
            boundary = end;
        } else {
            break;
        }
    }
    boundary
}

// ---------------------------------------------------------------------------
// Pure helper: digest + signature verification (mirrors `package_verify`)
// ---------------------------------------------------------------------------

/// The SHA-256 digest of a byte slice (streaming callers feed the finished file).
pub fn file_digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Lowercase hex encoding of a digest.
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The pinned set of model-signing keys the client trusts, indexed by `kid` (mirrors
/// [`crate::package_verify::PackageTrustedKeys`]).
#[derive(Debug, Clone, Default)]
pub struct ModelTrustedKeys {
    keys: BTreeMap<String, VerifyingKey>,
}

impl ModelTrustedKeys {
    pub fn new() -> Self {
        Self { keys: BTreeMap::new() }
    }

    /// Trust `kid`'s key, given as base64 X.509 SPKI Ed25519 public key (44 bytes:
    /// the standard 12-byte prefix + 32-byte raw key).
    pub fn insert_spki_b64(
        &mut self,
        kid: impl Into<String>,
        spki_b64: &str,
    ) -> Result<(), ModelVerifyError> {
        let der = STANDARD.decode(spki_b64.trim()).map_err(|_| ModelVerifyError::BadPublicKey)?;
        if der.len() != ED25519_SPKI_LEN || der[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX {
            return Err(ModelVerifyError::BadPublicKey);
        }
        let mut raw = [0u8; 32];
        raw.copy_from_slice(&der[ED25519_SPKI_PREFIX.len()..]);
        let key = VerifyingKey::from_bytes(&raw).map_err(|_| ModelVerifyError::BadPublicKey)?;
        self.keys.insert(kid.into(), key);
        Ok(())
    }

    /// Build a trusted-key set from `kid=spkiB64` pairs separated by `;` or `,`
    /// (as carried in [`TRUSTED_KEYS_ENV`]). Blank entries are skipped.
    pub fn from_env_spec(spec: &str) -> Result<Self, ModelVerifyError> {
        let mut set = Self::new();
        for entry in spec.split([';', ',']).map(str::trim).filter(|e| !e.is_empty()) {
            let (kid, b64) = entry.split_once('=').ok_or(ModelVerifyError::BadPublicKey)?;
            set.insert_spki_b64(kid.trim(), b64.trim())?;
        }
        Ok(set)
    }

    pub fn get(&self, kid: &str) -> Option<&VerifyingKey> {
        self.keys.get(kid)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// Parse an `ed25519:<base64>` wire signature into a 64-byte [`Signature`].
fn parse_signature(wire: &str) -> Result<Signature, ModelVerifyError> {
    let b64 = wire.trim().strip_prefix(SIGNATURE_PREFIX).ok_or(ModelVerifyError::MalformedSignature)?;
    let raw = STANDARD.decode(b64).map_err(|_| ModelVerifyError::MalformedSignature)?;
    let bytes: [u8; SIGNATURE_LEN] =
        raw.as_slice().try_into().map_err(|_| ModelVerifyError::MalformedSignature)?;
    Ok(Signature::from_bytes(&bytes))
}

/// Accept a finished model file: its SHA-256 must match `expected_hex`, AND a detached
/// Ed25519 signature over the **32-byte digest** must verify against the trusted key
/// pinned to `kid`. Both checks must pass; either failure rejects the file (fail-closed).
///
/// This is the offline gate the inference engine relies on — mirrors
/// [`crate::package_verify::verify`], but the signed message is the raw digest, not a
/// JCS-canonical manifest.
pub fn verify_model(
    digest: &[u8; 32],
    expected_hex: &str,
    signature_wire: &str,
    kid: &str,
    trusted: &ModelTrustedKeys,
) -> Result<(), ModelVerifyError> {
    // 1. content integrity: the bytes on disk hash to the digest the manifest promised.
    if !hex_lower(digest).eq_ignore_ascii_case(expected_hex.trim()) {
        return Err(ModelVerifyError::DigestMismatch);
    }
    // 2. authenticity: that digest was signed by a key we pinned (verify_strict rejects
    //    non-canonical signatures and small-order keys).
    let signature = parse_signature(signature_wire)?;
    let key = trusted.get(kid).ok_or(ModelVerifyError::UnknownKid)?;
    key.verify_strict(digest, &signature).map_err(|_| ModelVerifyError::SignatureMismatch)
}

/// The trusted-key set from the environment (empty when unset — every verify then fails
/// as `UnknownKid`, which is the correct fail-closed default until a key is pinned).
fn trusted_keys() -> ModelTrustedKeys {
    match std::env::var(TRUSTED_KEYS_ENV) {
        Ok(spec) => ModelTrustedKeys::from_env_spec(&spec).unwrap_or_default(),
        Err(_) => ModelTrustedKeys::new(),
    }
}

// ---------------------------------------------------------------------------
// Local file layout (pure)
// ---------------------------------------------------------------------------

/// The final, verified model path under the app-data `models/` dir.
pub fn model_dest_path(models_dir: &Path, model_id: &str, version: &str) -> PathBuf {
    models_dir.join(format!("{}-{}.gguf", sanitize(model_id), sanitize(version)))
}

/// The in-progress `.part` path a resume appends to (renamed to the final path only
/// after verification succeeds, so a partial/unverified file is never loadable).
pub fn model_part_path(models_dir: &Path, model_id: &str, version: &str) -> PathBuf {
    models_dir.join(format!("{}-{}.gguf.part", sanitize(model_id), sanitize(version)))
}

/// Reduce a model id / version to a filesystem-safe token (keep alnum, `.`, `-`, `_`).
fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect()
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

struct Inner {
    status: ModelDownloadStatus,
    cancel: Arc<AtomicBool>,
}

impl Default for Inner {
    fn default() -> Self {
        Self { status: ModelDownloadStatus::idle(), cancel: Arc::new(AtomicBool::new(false)) }
    }
}

/// The `.manage()`-d download handle the three commands drive. Cheaply cloneable
/// (an `Arc` to shared state + a clone of the reqwest client, which is itself `Arc`).
#[derive(Clone)]
pub struct DownloadManager {
    http: reqwest::Client,
    inner: Arc<Mutex<Inner>>,
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadManager {
    pub fn new() -> Self {
        Self { http: reqwest::Client::new(), inner: Arc::new(Mutex::new(Inner::default())) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("download manager mutex poisoned")
    }

    /// A snapshot of the current status.
    pub fn status(&self) -> ModelDownloadStatus {
        self.lock().status.clone()
    }

    /// Signal cancellation of the in-flight download (observed between chunks). The
    /// partial `.part` file is left in place so a later `start` can resume it.
    pub fn cancel(&self) -> ModelDownloadStatus {
        let inner = self.lock();
        inner.cancel.store(true, Ordering::SeqCst);
        inner.status.clone()
    }

    /// Begin (or no-op if one is already running) a download. Fails fast on an
    /// obviously-invalid request (a malformed delta manifest) so the caller gets a
    /// synchronous error rather than a `Failed` status later; otherwise sets up the
    /// shared status, spawns the background driver, and returns the initial
    /// `Downloading` snapshot (progress then arrives via `model_download://progress`).
    pub fn start(&self, app: AppHandle, args: ModelDownloadStartArgs) -> Result<ModelDownloadStatus, DownloadError> {
        if let Some(parts) = &args.parts {
            let total = args.total_bytes.unwrap_or_else(|| parts.iter().map(|p| p.size).sum());
            validate_parts(parts, total).map_err(DownloadError::Manifest)?;
        }
        {
            let mut inner = self.lock();
            if matches!(inner.status.phase, ModelDownloadPhase::Downloading | ModelDownloadPhase::Verifying) {
                // One download at a time — return the in-flight status unchanged.
                return Ok(inner.status.clone());
            }
            inner.cancel = Arc::new(AtomicBool::new(false));
            inner.status = ModelDownloadStatus {
                model_id: Some(args.model_id.clone()),
                phase: ModelDownloadPhase::Downloading,
                downloaded_bytes: 0,
                total_bytes: args.total_bytes.unwrap_or(0),
                model_path: None,
                error: None,
            };
        }
        let manager = self.clone();
        let cancel = self.lock().cancel.clone();
        tauri::async_runtime::spawn(async move {
            let result = manager.run_download(&app, &args, cancel).await;
            manager.finish(&app, &args, result);
        });
        Ok(self.lock().status.clone())
    }

    /// Record the terminal outcome + emit the final progress event.
    fn finish(&self, app: &AppHandle, args: &ModelDownloadStartArgs, result: Result<PathBuf, DownloadError>) {
        let mut inner = self.lock();
        match result {
            Ok(path) => {
                inner.status.phase = ModelDownloadPhase::Complete;
                inner.status.model_path = Some(path.to_string_lossy().into_owned());
                inner.status.error = None;
            }
            Err(DownloadError::Cancelled) => {
                inner.status.phase = ModelDownloadPhase::Cancelled;
            }
            Err(e) => {
                inner.status.phase = ModelDownloadPhase::Failed;
                inner.status.error = Some(e.to_string());
            }
        }
        let snapshot = inner.status.clone();
        drop(inner);
        emit_progress(app, &snapshot_progress(args, &snapshot));
    }

    /// The network-touching driver. Delegates every non-I/O decision to the pure helpers
    /// above; this wrapper only performs the HTTP + file I/O they describe.
    async fn run_download(
        &self,
        app: &AppHandle,
        args: &ModelDownloadStartArgs,
        cancel: Arc<AtomicBool>,
    ) -> Result<PathBuf, DownloadError> {
        let models_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| DownloadError::Io(e.to_string()))?
            .join("models");
        std::fs::create_dir_all(&models_dir).map_err(|e| DownloadError::Io(e.to_string()))?;
        let dest = model_dest_path(&models_dir, &args.model_id, &args.version);
        let part = model_part_path(&models_dir, &args.model_id, &args.version);

        // Already-verified? (A previous run finished.) Trust the on-disk final file.
        if dest.is_file() {
            return Ok(dest);
        }

        if let Some(parts) = &args.parts {
            self.download_delta(app, args, &part, parts, &cancel).await?;
        } else {
            self.download_blob(app, args, &part, &cancel).await?;
        }

        // Verify BEFORE accepting: hash the finished file (streamed, so a multi-GB model
        // is never loaded whole into RAM), check digest + signature.
        set_phase(app, self, args, ModelDownloadPhase::Verifying);
        let digest = digest_file(&part)?;
        verify_model(&digest, &args.sha256, &args.signature, &args.signing_key_id, &trusted_keys())?;

        // Promote the verified `.part` to the final path (atomic rename on the same dir).
        std::fs::rename(&part, &dest).map_err(|e| DownloadError::Io(e.to_string()))?;
        Ok(dest)
    }

    /// Single-blob path with Range resume: continue an existing `.part`, or start fresh
    /// if the server ignores the Range (answers `200` instead of `206`). `u64::MAX` as
    /// the decision total means "size unknown" ⇒ resume whenever any partial exists and
    /// let the server's 206/200 arbitrate; a known total additionally detects `Complete`.
    async fn download_blob(
        &self,
        app: &AppHandle,
        args: &ModelDownloadStartArgs,
        part: &Path,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), DownloadError> {
        let local = file_len(part);
        let mut offset = match resume_decision(local, args.total_bytes.unwrap_or(u64::MAX)) {
            ResumeDecision::Complete => return Ok(()), // fully present; verify next
            ResumeDecision::Resume { offset } => offset,
            ResumeDecision::Restart => {
                let _ = std::fs::remove_file(part);
                0
            }
            ResumeDecision::Fresh => 0,
        };

        let mut req = self.http.get(&args.url);
        if offset > 0 {
            req = req.header("Range", range_header(offset));
        }
        let resp = req.send().await.map_err(|e| DownloadError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        if !(status == 200 || status == 206) {
            return Err(DownloadError::Status { status });
        }
        // If we asked for a range but got a full 200, the server ignored it: restart.
        if offset > 0 && status == 200 {
            offset = 0;
        }
        if offset == 0 {
            let _ = std::fs::remove_file(part); // truncate on a fresh/restarted download
        }
        let total = match (status, resp.content_length()) {
            (206, Some(remaining)) => offset + remaining,
            (_, Some(len)) => len,
            _ => args.total_bytes.unwrap_or(0),
        };
        self.stream_append(app, args, part, resp, offset, total, cancel).await?;
        Ok(())
    }

    /// Delta path: truncate any partial back to a clean part boundary, then fetch only
    /// the parts still needed, appending each in order.
    async fn download_delta(
        &self,
        app: &AppHandle,
        args: &ModelDownloadStartArgs,
        part: &Path,
        parts: &[ModelDeltaPart],
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), DownloadError> {
        let total = args.total_bytes.unwrap_or_else(|| parts.iter().map(|p| p.size).sum());
        validate_parts(parts, total).map_err(DownloadError::Manifest)?;

        // Resume only at a part boundary: discard any trailing half-written part.
        let have = file_len(part);
        let boundary = part_resume_boundary(parts, have);
        truncate_to(part, boundary)?;

        let mut downloaded = boundary;
        for p in parts_to_fetch(parts, boundary) {
            if cancel.load(Ordering::SeqCst) {
                return Err(DownloadError::Cancelled);
            }
            let url = part_url(&args.url, &p.path);
            let resp = self
                .http
                .get(&url)
                .send()
                .await
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            let status = resp.status().as_u16();
            if !(200..300).contains(&status) {
                return Err(DownloadError::Status { status });
            }
            downloaded = self.stream_append(app, args, part, resp, downloaded, total, cancel).await?;
        }
        Ok(())
    }

    /// The inner append loop shared by the blob + delta paths. Writes each chunk to the
    /// `.part` file, tracks + throttles progress, and returns the new byte count.
    async fn stream_append(
        &self,
        app: &AppHandle,
        args: &ModelDownloadStartArgs,
        part: &Path,
        mut resp: reqwest::Response,
        start: u64,
        total: u64,
        cancel: &Arc<AtomicBool>,
    ) -> Result<u64, DownloadError> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(part)
            .map_err(|e| DownloadError::Io(e.to_string()))?;
        let mut downloaded = start;
        let mut last_emit = start;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(DownloadError::Cancelled);
            }
            match resp.chunk().await.map_err(|e| DownloadError::Network(e.to_string()))? {
                Some(chunk) => {
                    file.write_all(&chunk).map_err(|e| DownloadError::Io(e.to_string()))?;
                    downloaded += chunk.len() as u64;
                    self.set_progress(downloaded, total);
                    if downloaded - last_emit >= PROGRESS_STRIDE_BYTES {
                        last_emit = downloaded;
                        emit_progress(
                            app,
                            &ModelDownloadProgressEvent {
                                model_id: args.model_id.clone(),
                                downloaded_bytes: downloaded,
                                total_bytes: total,
                                phase: ModelDownloadPhase::Downloading,
                            },
                        );
                    }
                }
                None => break,
            }
        }
        file.flush().map_err(|e| DownloadError::Io(e.to_string()))?;
        Ok(downloaded)
    }

    /// Update the shared status' byte counters (read by `model_download_status`).
    fn set_progress(&self, downloaded: u64, total: u64) {
        let mut inner = self.lock();
        inner.status.downloaded_bytes = downloaded;
        if total > 0 {
            inner.status.total_bytes = total;
        }
    }
}

// ---------------------------------------------------------------------------
// small local helpers (kept out of the pure/tested set — trivial I/O glue)
// ---------------------------------------------------------------------------

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Stream `path` through SHA-256, returning the digest without loading the file into
/// RAM (the finished model may be multiple GB).
fn digest_file(path: &Path) -> Result<[u8; 32], DownloadError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| DownloadError::Io(e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| DownloadError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

/// Truncate `part` to `len` bytes (no-op if it is already ≤ `len` or absent). Used to
/// discard a half-written trailing delta part before resuming at a clean boundary.
fn truncate_to(part: &Path, len: u64) -> Result<(), DownloadError> {
    if len == 0 {
        let _ = std::fs::remove_file(part);
        return Ok(());
    }
    if file_len(part) > len {
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(part)
            .map_err(|e| DownloadError::Io(e.to_string()))?;
        f.set_len(len).map_err(|e| DownloadError::Io(e.to_string()))?;
    }
    Ok(())
}

fn set_phase(app: &AppHandle, manager: &DownloadManager, args: &ModelDownloadStartArgs, phase: ModelDownloadPhase) {
    let snapshot = {
        let mut inner = manager.lock();
        inner.status.phase = phase;
        inner.status.clone()
    };
    emit_progress(app, &snapshot_progress(args, &snapshot));
}

fn snapshot_progress(args: &ModelDownloadStartArgs, status: &ModelDownloadStatus) -> ModelDownloadProgressEvent {
    ModelDownloadProgressEvent {
        model_id: args.model_id.clone(),
        downloaded_bytes: status.downloaded_bytes,
        total_bytes: status.total_bytes,
        phase: status.phase,
    }
}

fn emit_progress(app: &AppHandle, event: &ModelDownloadProgressEvent) {
    let _ = app.emit("model_download://progress", event.clone());
}

// ---------------------------------------------------------------------------
// Tauri commands (registered in main.rs `generate_handler!`)
// ---------------------------------------------------------------------------

/// Start streaming + verifying a model. Returns immediately with the initial status;
/// progress arrives as `model_download://progress` events and via `model_download_status`.
#[tauri::command]
pub fn model_download_start(
    args: ModelDownloadStartArgs,
    manager: State<'_, DownloadManager>,
    app: AppHandle,
) -> Result<ModelDownloadStatus, CmdError> {
    // A malformed delta manifest fails synchronously here (DownloadError → CmdError::Download);
    // transport/verify failures surface later via `model_download_status` (phase = Failed).
    Ok(manager.start(app, args)?)
}

/// The current download status (phase, byte counters, verified path or error).
#[tauri::command]
pub fn model_download_status(
    manager: State<'_, DownloadManager>,
) -> Result<ModelDownloadStatus, CmdError> {
    Ok(manager.status())
}

/// Request cancellation of the in-flight download (the `.part` file is kept for resume).
#[tauri::command]
pub fn model_download_cancel(
    manager: State<'_, DownloadManager>,
) -> Result<ModelDownloadStatus, CmdError> {
    Ok(manager.cancel())
}

// ---------------------------------------------------------------------------
// Tests — the PURE helpers only (url/range/resume/delta/digest-verify). No sockets,
// no real files: `verify_model` is exercised with an in-test Ed25519 keypair.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    // --- url building ------------------------------------------------------

    #[test]
    fn join_url_normalizes_slashes() {
        assert_eq!(join_url("http://h", "/models/x.gguf"), "http://h/models/x.gguf");
        assert_eq!(join_url("http://h/", "models/x.gguf"), "http://h/models/x.gguf");
        assert_eq!(join_url("http://h/", "/models/x.gguf"), "http://h/models/x.gguf");
    }

    #[test]
    fn part_url_joins_relative_and_passes_absolute() {
        assert_eq!(part_url("http://h/base", "p/0.bin"), "http://h/base/p/0.bin");
        assert_eq!(
            part_url("http://h/base", "https://cdn/p/0.bin"),
            "https://cdn/p/0.bin",
            "an absolute part path is used verbatim"
        );
    }

    // --- range math + resume decision -------------------------------------

    #[test]
    fn range_header_formats_open_ended_range() {
        assert_eq!(range_header(0), "bytes=0-");
        assert_eq!(range_header(1_048_576), "bytes=1048576-");
    }

    #[test]
    fn resume_decision_covers_every_case() {
        assert_eq!(resume_decision(0, 0), ResumeDecision::Fresh, "unknown total => fresh");
        assert_eq!(resume_decision(500, 0), ResumeDecision::Fresh, "unknown total => fresh even w/ local");
        assert_eq!(resume_decision(0, 100), ResumeDecision::Fresh);
        assert_eq!(resume_decision(40, 100), ResumeDecision::Resume { offset: 40 });
        assert_eq!(resume_decision(100, 100), ResumeDecision::Complete);
        assert_eq!(resume_decision(140, 100), ResumeDecision::Restart, "local > total => restart");
    }

    // --- delta manifest ----------------------------------------------------

    fn part(offset: u64, size: u64) -> ModelDeltaPart {
        ModelDeltaPart { path: format!("p/{offset}.bin"), offset, size, sha256: None }
    }

    #[test]
    fn validate_parts_accepts_a_contiguous_cover() {
        let parts = [part(0, 100), part(100, 100), part(200, 50)];
        assert!(validate_parts(&parts, 250).is_ok());
    }

    #[test]
    fn validate_parts_rejects_gaps_overlaps_and_wrong_total() {
        // gap: 0..100 then 150..
        assert!(validate_parts(&[part(0, 100), part(150, 50)], 200).is_err());
        // overlap: 0..100 then 50..
        assert!(validate_parts(&[part(0, 100), part(50, 100)], 150).is_err());
        // right layout, wrong declared total
        assert!(validate_parts(&[part(0, 100)], 200).is_err());
        // empty
        assert!(validate_parts(&[], 0).is_err());
    }

    #[test]
    fn parts_to_fetch_skips_fully_downloaded_parts() {
        let parts = [part(0, 100), part(100, 100), part(200, 100)];
        // nothing on disk -> all three
        assert_eq!(parts_to_fetch(&parts, 0).len(), 3);
        // first part fully present -> two remain
        let remaining = parts_to_fetch(&parts, 100);
        assert_eq!(remaining.len(), 2);
        assert_eq!(remaining[0].offset, 100);
        // partway into the second part -> still fetch part 2 (partly needed) + part 3
        assert_eq!(parts_to_fetch(&parts, 150).len(), 2);
        // everything present -> none
        assert!(parts_to_fetch(&parts, 300).is_empty());
    }

    #[test]
    fn part_resume_boundary_snaps_back_to_a_clean_boundary() {
        let parts = [part(0, 100), part(100, 100), part(200, 100)];
        assert_eq!(part_resume_boundary(&parts, 0), 0);
        assert_eq!(part_resume_boundary(&parts, 100), 100, "exactly on a boundary");
        assert_eq!(part_resume_boundary(&parts, 150), 100, "mid-part snaps back down");
        assert_eq!(part_resume_boundary(&parts, 250), 200);
        assert_eq!(part_resume_boundary(&parts, 300), 300, "all parts complete");
    }

    // --- digest + signature verification ----------------------------------

    /// Build a base64 X.509 SPKI blob from a 32-byte raw Ed25519 public key.
    fn spki_b64(vk: &VerifyingKey) -> String {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(vk.as_bytes());
        STANDARD.encode(der)
    }

    /// A deterministic keypair + a trusted set that trusts it under `kid`.
    fn keypair_and_trust(kid: &str) -> (SigningKey, ModelTrustedKeys) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let mut trusted = ModelTrustedKeys::new();
        trusted.insert_spki_b64(kid, &spki_b64(&sk.verifying_key())).unwrap();
        (sk, trusted)
    }

    #[test]
    fn hex_lower_is_lowercase_and_padded() {
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
        assert_eq!(file_digest(b"").len(), 32);
    }

    #[test]
    fn verify_model_accepts_a_correctly_signed_file() {
        let bytes = b"pretend GGUF weights";
        let digest = file_digest(bytes);
        let expected_hex = hex_lower(&digest);
        let (sk, trusted) = keypair_and_trust("model-key-1");
        // The signer signs over the 32-byte digest (not the hex, not the file bytes).
        let sig = format!("ed25519:{}", STANDARD.encode(sk.sign(&digest).to_bytes()));

        assert_eq!(verify_model(&digest, &expected_hex, &sig, "model-key-1", &trusted), Ok(()));
        // hex is compared case-insensitively.
        assert_eq!(
            verify_model(&digest, &expected_hex.to_uppercase(), &sig, "model-key-1", &trusted),
            Ok(())
        );
    }

    #[test]
    fn verify_model_rejects_a_digest_mismatch_before_touching_the_signature() {
        let digest = file_digest(b"real bytes");
        let (sk, trusted) = keypair_and_trust("k");
        let sig = format!("ed25519:{}", STANDARD.encode(sk.sign(&digest).to_bytes()));
        // Claim a different expected digest -> integrity fails first.
        let wrong = hex_lower(&file_digest(b"other bytes"));
        assert_eq!(
            verify_model(&digest, &wrong, &sig, "k", &trusted),
            Err(ModelVerifyError::DigestMismatch)
        );
    }

    #[test]
    fn verify_model_rejects_a_forged_or_wrong_key_signature() {
        let digest = file_digest(b"weights");
        let expected = hex_lower(&digest);
        let (_sk, trusted) = keypair_and_trust("k");
        // Sign the correct digest with a DIFFERENT key than the trusted one.
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let sig = format!("ed25519:{}", STANDARD.encode(attacker.sign(&digest).to_bytes()));
        assert_eq!(
            verify_model(&digest, &expected, &sig, "k", &trusted),
            Err(ModelVerifyError::SignatureMismatch)
        );
    }

    #[test]
    fn verify_model_rejects_an_unknown_kid_and_malformed_signature() {
        let digest = file_digest(b"weights");
        let expected = hex_lower(&digest);
        let (sk, trusted) = keypair_and_trust("known");
        let sig = format!("ed25519:{}", STANDARD.encode(sk.sign(&digest).to_bytes()));

        // A kid the trusted set does not know.
        assert_eq!(
            verify_model(&digest, &expected, &sig, "stranger", &trusted),
            Err(ModelVerifyError::UnknownKid)
        );
        // Not `ed25519:<base64-of-64-bytes>`.
        assert_eq!(
            verify_model(&digest, &expected, "ed25519:AAAA", "known", &trusted),
            Err(ModelVerifyError::MalformedSignature)
        );
        assert_eq!(
            verify_model(&digest, &expected, "not-prefixed", "known", &trusted),
            Err(ModelVerifyError::MalformedSignature)
        );
    }

    #[test]
    fn trusted_keys_from_env_spec_parses_pairs_and_rejects_bad_keys() {
        let (sk, _t) = keypair_and_trust("x");
        let b64 = spki_b64(&sk.verifying_key());
        let spec = format!("k1={b64}; k2={b64}");
        let set = ModelTrustedKeys::from_env_spec(&spec).unwrap();
        assert_eq!(set.len(), 2);
        assert!(set.get("k1").is_some());
        assert!(set.get("k2").is_some());
        // A malformed pair (no `=`) is rejected.
        assert!(ModelTrustedKeys::from_env_spec("garbage").is_err());
        // A blank spec is an empty (fail-closed) set.
        assert!(ModelTrustedKeys::from_env_spec("   ").unwrap().is_empty());
    }

    // --- local file layout -------------------------------------------------

    #[test]
    fn dest_and_part_paths_are_sanitized_and_distinct() {
        let dir = Path::new("/models");
        let dest = model_dest_path(dir, "qwen2.5-3b", "1.0.0");
        let part = model_part_path(dir, "qwen2.5-3b", "1.0.0");
        assert!(dest.to_string_lossy().ends_with("qwen2.5-3b-1.0.0.gguf"));
        assert!(part.to_string_lossy().ends_with("qwen2.5-3b-1.0.0.gguf.part"));
        assert_ne!(dest, part);
        // Path separators in the id/version are flattened, so the result is a single
        // filename component under `dir` — a `../` can never traverse out.
        let evil = model_dest_path(dir, "../../etc", "v/1");
        let fname = evil.file_name().unwrap().to_string_lossy();
        assert!(!fname.contains('/') && !fname.contains('\\'), "no separators survive");
        assert_eq!(evil.parent(), Some(dir), "stays inside the models dir");
    }
}
