//! Hydropark Phase-0 — Rust ↔ Angular IPC contract.
//!
//! This is the Rust mirror of `client/web/src/app/ipc/contract.ts`. Field
//! names are kept identical (snake_case on both sides — see that file's
//! header comment for why) so the two are easy to diff by eye. If you add
//! or change a message here, make the matching edit there, and vice versa;
//! see `client/IPC-CONTRACT.md` for the full responsibility split and the
//! "keeping the two sides in sync" checklist.
//!
//! Every command's error type is `CmdError` (below), which Tauri requires
//! to implement `Serialize` so it can cross the IPC boundary as a string.

use serde::{Deserialize, Serialize};
use std::fmt;

// ---------------------------------------------------------------------------
// Tool registry (P0-03.1)
// ---------------------------------------------------------------------------

/// The fixed, hardcoded Phase-0 tool catalog. No manifest, no discovery —
/// mirrors `ToolName` in contract.ts exactly (3 variants, nothing else).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    StartTimer,
    ConvertUnits,
    ListManage,
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ToolName::StartTimer => "start_timer",
            ToolName::ConvertUnits => "convert_units",
            ToolName::ListManage => "list_manage",
        };
        write!(f, "{s}")
    }
}

// --- start_timer -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartTimerArgs {
    pub label: String,
    pub duration_sec: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartTimerResult {
    pub timer_id: String,
    pub label: String,
    pub duration_sec: u32,
    pub started_at_ms: i64,
}

// --- convert_units -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitDomain {
    Mass,
    Volume,
    Temperature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnitSystem {
    US,
    Metric,
}

/// Matches `UnitId` in contract.ts. `#[serde(rename_all = "snake_case")]`
/// makes `FlOz` serialize as `"fl_oz"` to match the TS string union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitId {
    G,
    Kg,
    Oz,
    Lb,
    Ml,
    L,
    Tsp,
    Tbsp,
    FlOz,
    Cup,
    C,
    F,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertUnitsArgs {
    pub domain: UnitDomain,
    pub value: f64,
    pub from_unit: UnitId,
    pub to_unit: UnitId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertUnitsResult {
    pub value: f64,
    pub unit: UnitId,
}

// --- list_manage -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListOp {
    Add,
    Remove,
    Check,
    Uncheck,
    SetAll,
}

/// Matches SPEC §8.3.4's `item` record: `{ id, name, qty?, unit?, checked? }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngredientItem {
    /// Stable, app-assigned id (set on insert) — never chosen by the caller on add.
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<UnitId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
}

/// Loosely-typed patch used for add/remove/check/uncheck — mirrors
/// `Partial<IngredientItem>` in contract.ts (all fields optional; validated
/// per-op in `tools.rs::validate_list_manage_args`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IngredientItemPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<UnitId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListManageArgs {
    pub op: ListOp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<IngredientItemPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<IngredientItemPatch>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListManageResult {
    pub ingredients: Vec<IngredientItem>,
}

/// Who triggered the call — the UI-first path (P0-03.6) or the model path (P0-04.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallSource {
    Ui,
    Model,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub request_id: String,
    pub tool: ToolName,
    pub args: serde_json::Value,
    pub source: ToolCallSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallErrorCode {
    UnknownTool,
    InvalidArgs,
    ExecutionError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallError {
    pub code: ToolCallErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolCallResponse {
    Ok {
        request_id: String,
        ok: bool, // always true; kept as a field (not solely the variant) to match the TS discriminated union shape
        tool: ToolName,
        result: serde_json::Value,
    },
    Err {
        request_id: String,
        ok: bool, // always false
        tool: Option<ToolName>,
        error: ToolCallError,
    },
}

// ---------------------------------------------------------------------------
// Inference (P0-02.x, P0-04.x)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceStartArgs {
    pub session_id: String,
    pub user_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<SkillId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceCancelArgs {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceTokenEvent {
    pub session_id: String,
    pub seq: u64,
    pub token: String,
}

/// Emitted whenever the model emits a `<tool_call>` block. Rust has ALREADY
/// decided validity and (if valid) executed it before this event is sent —
/// see IPC-CONTRACT.md "Tool-call turn sequence". The webview never
/// re-validates; it only renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceToolCallDetectedEvent {
    pub session_id: String,
    pub raw: String,
    pub tool: Option<ToolName>,
    pub parsed_args: Option<serde_json::Value>,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceToolCallResultEvent {
    pub session_id: String,
    pub tool: ToolName,
    pub result: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackReason {
    MalformedJson,
    UnknownTool,
    InvalidArgs,
}

/// Invalid/malformed call: no repair loop (P0-04.2 — a deliberate scope cut
/// from the SPEC §8.4 production "one repair attempt" state machine). The
/// webview must degrade to exactly one of: prefill the tool's bound
/// widget, or post one clarifying question to chat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceToolCallFallbackEvent {
    pub session_id: String,
    pub reason: FallbackReason,
    pub tool: Option<ToolName>,
    pub parsed_args: Option<serde_json::Value>,
    pub clarifying_question: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceDoneEvent {
    pub session_id: String,
    pub tokens_generated: u64,
    pub elapsed_ms: f64,
    pub tok_per_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceErrorEvent {
    pub session_id: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Model download manager (P1-02.7) — the Rust core streams + SIGNATURE-VERIFIES
// the GGUF before the inference engine may load it (see `downloader.rs`). Same
// snake_case wire shape as the inference events above (this is the model side of
// the inference domain, not the marketplace/commerce camelCase family). The
// Angular mirror in contract.ts is a later tranche (the download UI + a live model
// host are out of scope for this ticket — the verify/resume LOGIC is what ships here).
// ---------------------------------------------------------------------------

/// One part of a delta manifest: a byte range of the assembled file fetched from a
/// (relative or absolute) `path`, with an optional per-part digest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDeltaPart {
    pub path: String,
    pub offset: u64,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// `model_download_start` args. `url` is the resolved GGUF blob URL, or the base the
/// delta `parts` resolve against. `sha256`/`signature`/`signing_key_id` are the trust
/// triple the finished file is checked against before it is accepted (mirrors the
/// package-manifest trust model): the file's SHA-256 must equal `sha256`, and the
/// detached `ed25519:<base64>` `signature` over that 32-byte digest must verify against
/// the pinned key named by `signing_key_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadStartArgs {
    pub model_id: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub signature: String,
    pub signing_key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<ModelDeltaPart>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

/// The lifecycle phase of the (single, at-a-time) model download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelDownloadPhase {
    Idle,
    Downloading,
    Verifying,
    Complete,
    Failed,
    Cancelled,
}

/// Streamed to `model_download://progress` as bytes arrive and on each phase change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadProgressEvent {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub phase: ModelDownloadPhase,
}

/// The snapshot returned by `model_download_start` / `_status` / `_cancel`. `model_path`
/// is set only once the file is downloaded AND verified (the promotion point).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub phase: ModelDownloadPhase,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ModelDownloadStatus {
    /// The at-rest status before any download has been requested.
    pub fn idle() -> Self {
        Self {
            model_id: None,
            phase: ModelDownloadPhase::Idle,
            downloaded_bytes: 0,
            total_bytes: 0,
            model_path: None,
            error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Skills (P0-05.1)
// ---------------------------------------------------------------------------

/// Phase-0 ships exactly two hardcoded skills (SPEC §26.4). Only
/// `KitchenTimer` is wired up by this client scaffold; `CookingAssistant`
/// (the paid $5 SKU, P0-05.3/.5) is out of scope here — see client/README.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillId {
    KitchenTimer,
    CookingAssistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEnableArgs {
    pub skill_id: SkillId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEnableResult {
    pub skill_id: SkillId,
    pub persona_injected: bool,
    pub tools_registered: Vec<ToolName>,
    pub panels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDisableArgs {
    pub skill_id: SkillId,
}

// ---------------------------------------------------------------------------
// Timers (Rust-owned countdown source of truth)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerControlArgs {
    pub timer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerStateSnapshot {
    pub timer_id: String,
    pub label: String,
    pub duration_sec: u32,
    pub remaining_sec: u32,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerTickEvent {
    pub timer_id: String,
    pub remaining_sec: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimerFinishedEvent {
    pub timer_id: String,
    pub label: String,
}

// ---------------------------------------------------------------------------
// Hardware profiling (P0-02.3) — read-only, never gates a feature
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub ram_gb: f64,
    pub cores: u32,
    pub gpu_present: bool,
}

// ---------------------------------------------------------------------------
// OS notifications (P0-05.4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyArgs {
    pub title: String,
    pub body: String,
    pub sound: bool,
}

// ---------------------------------------------------------------------------
// Telemetry (P0-06.1 / P0-06.2) — one shared, versioned event schema
// ---------------------------------------------------------------------------

pub const TELEMETRY_SCHEMA_VERSION: u32 = 1;

/// Deliberately untyped on the Rust receiving side: the webview is the
/// producer of telemetry envelopes (it knows the UI-side "why"), Rust is
/// just the sink that appends a validated JSON line to the session's
/// `.jsonl` file. `serde_json::Value` here (rather than a matching Rust
/// enum of every event shape — the P0 session events plus the P1-25.1
/// product metrics: `activation`, `composition`, `offline_usage`,
/// `crash_free_session`) avoids the two sides needing to release in
/// lockstep on every new event field — the schema is versioned
/// (`schema_version`) precisely so this sink can validate/reject on that
/// field without needing to know every variant.
pub type TelemetryEvent = serde_json::Value;

// ---------------------------------------------------------------------------
// Marketplace / live-flow commands (P1-08.x) — catalog, orders, entitlements,
// license, download. UNLIKE the rest of this file (snake_case on the IPC wire,
// see the header + IPC-CONTRACT.md), these commands use **camelCase** field
// names on the Rust<->Angular boundary: that is the shape both halves of the
// live-flow wiring were specified against, and the shape Angular's
// `invoke(name, { args })` sends/expects. The Rust core (not the webview) owns
// network egress — the webview CSP is `connect-src 'self'` — so these cross the
// IPC boundary as Tauri commands that call `backend_client.rs`. The backend's
// own wire shape is snake_case and reshaped here; `backend_client.rs` decodes
// the backend JSON into these types.
// ---------------------------------------------------------------------------

// --- catalog (PUBLIC — no bearer) ------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogListArgs {
    #[serde(default)]
    pub region: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDetailArgs {
    pub skill_id: String,
}

/// One marketplace card. `priceCents == 0` means free. `sizeBytes`/`category`/
/// `pitch`/`ownership` are `null` when the backend has no value (e.g. bundles
/// carry no category/size; `ownership` is `null` for an anonymous caller,
/// distinguishing "not authenticated" from "authenticated and not owned").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    pub pitch: Option<String>,
    pub category: Option<String>,
    pub price_cents: i64,
    pub size_bytes: Option<i64>,
    pub hardware_badge: String,
    pub ownership: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogListResult {
    pub skills: Vec<CatalogItem>,
}

/// `GET /v1/catalog/skills/{id}` reshaped for the detail page. Carries the
/// backend's `compressed_prompt` teaser ONLY — never a full system prompt
/// (there is no such field on the wire; see SkillDetailDto's javadoc).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub id: String,
    pub name: String,
    pub pitch: Option<String>,
    pub category: Option<String>,
    pub price_cents: i64,
    pub is_free: bool,
    pub status: String,
    pub compressed_prompt: Option<String>,
    pub has_preview: bool,
    pub min_model_tier: Option<String>,
    pub hardware_badge: String,
    pub size_bytes: Option<i64>,
    pub current_version: Option<String>,
    pub changelog: Option<String>,
    pub ownership: Option<bool>,
}

// --- orders (optional bearer) ----------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderCheckoutArgs {
    pub target_id: String,
    pub region: String,
    #[serde(default)]
    pub bearer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResult {
    pub order_id: String,
    pub checkout_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderGetArgs {
    pub order_id: String,
    #[serde(default)]
    pub bearer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStatusResult {
    pub order_id: String,
    pub status: String,
}

// --- entitlements (optional bearer) ----------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementsGetArgs {
    #[serde(default)]
    pub bearer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementItem {
    pub skill_id: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementsResult {
    pub skills: Vec<EntitlementItem>,
}

// --- license issue (optional bearer) ---------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFetchArgs {
    pub skill_id: String,
    #[serde(default)]
    pub bearer: Option<String>,
}

/// The offline-verifiable compact JWS (the backend's `token`); `license_verify.rs`
/// is what checks it against the pinned per-`kid` key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseResult {
    pub compact_jws: String,
}

// --- download URL (optional bearer) ----------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadUrlArgs {
    pub skill_id: String,
    pub version: String,
    #[serde(default)]
    pub bearer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadUrlResult {
    pub url: String,
    pub expires_at: String,
    pub watermark: String,
}

// ---------------------------------------------------------------------------
// Accounts / licensing (P1-09.x) + step-up (P1-09.8). Same camelCase IPC family
// as the marketplace commands above. The Rust core owns the session: it persists
// the access+refresh token pair (T2 SQLite store) and re-attaches the bearer to
// every authed backend call, so the webview never handles a raw token. `deviceId`
// is the STABLE local install id (always present, even signed-out / offline).
// ---------------------------------------------------------------------------

/// `auth_register` / `auth_login` args — email + password.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredentialsArgs {
    pub email: String,
    pub password: String,
}

/// The account+device status the webview hydrates from (`auth_status`, and the
/// return of register/login/logout). `email` is present only for an authenticated
/// account that has one; `deviceId` is the stable install id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub device_id: String,
}

/// `device_ensure` result — the stable install id + whether the backend registry
/// has accepted this device (needs a session; false when signed out).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEnsureResult {
    pub device_id: String,
    pub registered: bool,
}

/// `step_up_answer` args — the server-issued step-up challenge string to sign
/// (P1-09.8 client half).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepUpAnswerArgs {
    pub challenge: String,
}

/// `step_up_answer` result — the base64 Ed25519 signature over the challenge, plus
/// the signing device's stable install id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepUpAnswerResult {
    pub signature: String,
    pub device_id: String,
}

// ---------------------------------------------------------------------------
// .hpskill install / uninstall (P1-03.2). Same camelCase IPC family as the
// marketplace commands above. The Rust core (`hpskill.rs`) opens a downloaded
// `.hpskill` package from a local `path`, verifies its detached signature against
// the pinned package-signing trust set, re-validates the manifest, gates on host
// compatibility, extracts the sanitized assets to the app-data skills dir, and
// registers + persists the install. Fail-closed: on any failure nothing is
// written or registered and the command rejects with `CmdError::Package`.
// ---------------------------------------------------------------------------

/// `skill_install` args — the local filesystem path of the `.hpskill` archive the
/// downloader already fetched (the webview never handles package bytes).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallArgs {
    pub path: String,
}

/// `skill_install` result — the installed skill's id + resolved version, the
/// on-disk extraction dir, and its resulting lifecycle state (normally
/// `installed_disabled`; the composer enables it in a later step).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallResult {
    pub skill_id: String,
    pub version: String,
    pub dir: String,
    pub state: String,
}

/// `skill_uninstall` args — the skill id to remove (frees the disk, keeps
/// ownership; §11.3 reinstall is free).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUninstallArgs {
    pub skill_id: String,
}

/// `skill_uninstall` result — the id and its resulting lifecycle state (normally
/// `owned_not_installed`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUninstallResult {
    pub skill_id: String,
    pub state: String,
}

// ---------------------------------------------------------------------------
// Command errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CmdError {
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("tool execution failed: {0}")]
    ExecutionError(String),
    #[error("unknown timer: {0}")]
    UnknownTimer(String),
    #[error("io error: {0}")]
    Io(String),
    /// The paid Cooking Assistant skill is enabled before a valid unlock code was
    /// redeemed (P0-05.3/.5). The webview surfaces this as the locked state.
    #[error("skill is locked; redeem an unlock code first")]
    SkillLocked,
    /// A backend HTTP call (catalog / orders / entitlements / license / download)
    /// failed — network, non-2xx status, or an undecodable body. Carries the
    /// `backend_client::BackendError`'s message; see that module for the taxonomy.
    #[error("backend request failed: {0}")]
    Backend(String),
    /// A local account/session/device store operation failed (P1-09.x): the
    /// on-device SQLite session/device tables, or device-key handling. Carries the
    /// `store::StoreError` / `device::DeviceError` message.
    #[error("account store error: {0}")]
    Account(String),
    /// A model download (P1-02.7) failed — transport, a non-2xx status, an I/O error,
    /// or (crucially) the finished file failing signature verification. Carries the
    /// `downloader::DownloadError` message.
    #[error("model download failed: {0}")]
    Download(String),
    /// A `.hpskill` install/uninstall (P1-03.2) failed — a malformed archive, an
    /// unsigned / tampered / unknown-kid signature, a manifest that failed
    /// re-validation, an incompatible host (min_app_version / min_model_tier), a
    /// path-traversal or non-`.svg`/`.json` entry, or an on-disk error. Fail-closed:
    /// nothing is registered or persisted. Carries the `hpskill::HpSkillError` message.
    #[error("skill package error: {0}")]
    Package(String),
}

impl From<std::io::Error> for CmdError {
    fn from(e: std::io::Error) -> Self {
        CmdError::Io(e.to_string())
    }
}

// Tauri v2 requires command error types to implement `Serialize` so they
// can cross the IPC boundary as the `reject` side of the JS promise.
impl Serialize for CmdError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
