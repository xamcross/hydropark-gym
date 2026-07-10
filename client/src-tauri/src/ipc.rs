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
/// enum of the 6 event shapes) avoids the two sides needing to release in
/// lockstep on every new event field — the schema is versioned
/// (`schema_version`) precisely so this sink can validate/reject on that
/// field without needing to know every variant.
pub type TelemetryEvent = serde_json::Value;

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
