#![allow(dead_code)] // Phase-1 tool catalog; wired into the turn loop in a later ticket.

//! The fixed, first-party, audited tool catalog (P1-05.1) and its structured
//! execution-error semantics (P1-05.4).
//!
//! SPEC §8.1 #2 / §8.5 make the tool set a **closed, audited catalog with typed
//! contracts**: skills only *reference* these tools, they never ship executable
//! code, and adding a tool is a reviewed, versioned catalog change — this is the
//! backbone of marketplace safety. The Phase-1 catalog is EXACTLY the five tools
//! in the manifest schema's closed `toolRef` enum
//! (contracts/skill-manifest.schema.json): `start_timer`, `convert_units`,
//! `list_manage`, `calculate`, `date_math`.
//!
//! For each tool this module owns a **typed contract** (typed args + typed
//! result, serde), a human `description`, and **validation**; a **registry**
//! that resolves a tool ref, lists the catalog, and turns raw JSON args into
//! typed args ([`validate_and_parse`]); and the structured [`ToolError`] the
//! turn loop must surface (SPEC §8.4 pt 4: tool-execution errors return a
//! structured error the model must acknowledge — the app never silently
//! swallows a failed action).
//!
//! **Two `ToolName`s, on purpose.** `crate::ipc::ToolName` is the Phase-0 wire
//! enum (3 hardcoded tools). This module defines the *canonical* Phase-1
//! [`ToolName`] — the full 5-tool set. The three P0 tools reuse their existing
//! typed contracts verbatim from `crate::ipc` (so the catalog and the P0 wire
//! types can never drift); `calculate` and `date_math` are new here.
//!
//! **Pure by construction.** No Tauri / inference coupling, so it unit-tests
//! standalone (`cargo test --no-default-features --features mock-inference`).
//! The three STATELESS tools (`convert_units`, `calculate`, `date_math`) execute
//! purely here; the two STATEFUL tools (`start_timer`, `list_manage`) are
//! validated here but *executed* by the Tool Runtime against its `AppState` /
//! shared store (tools.rs) — see [`is_stateful`] and [`execute`].

use std::fmt;

use chrono::{DateTime, Duration};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ipc::{
    ConvertUnitsArgs, ConvertUnitsResult, IngredientItemPatch, ListManageArgs, ListManageResult,
    ListOp, StartTimerArgs, StartTimerResult, ToolCallError, ToolCallErrorCode, UnitDomain, UnitId,
};

// ---------------------------------------------------------------------------
// Canonical tool name (the closed 5-tool set — mirrors the schema `toolRef`
// enum). `snake_case` serde to match ipc.rs and the manifest schema.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    StartTimer,
    ConvertUnits,
    ListManage,
    Calculate,
    DateMath,
}

impl ToolName {
    /// The catalog, in schema order.
    pub const ALL: [ToolName; 5] = [
        Self::StartTimer,
        Self::ConvertUnits,
        Self::ListManage,
        Self::Calculate,
        Self::DateMath,
    ];

    /// The stable `ref` string a manifest uses to name this tool (snake_case).
    pub fn as_ref_str(self) -> &'static str {
        match self {
            Self::StartTimer => "start_timer",
            Self::ConvertUnits => "convert_units",
            Self::ListManage => "list_manage",
            Self::Calculate => "calculate",
            Self::DateMath => "date_math",
        }
    }

    /// Resolve a manifest `ref` to a catalog tool, or `None` if it is not in the
    /// fixed catalog (the closed-enum guarantee: skills cannot name arbitrary tools).
    pub fn from_ref(s: &str) -> Option<ToolName> {
        Self::ALL.into_iter().find(|t| t.as_ref_str() == s)
    }
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_ref_str())
    }
}

impl std::str::FromStr for ToolName {
    type Err = ToolError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        resolve(s)
    }
}

// ---------------------------------------------------------------------------
// Catalog descriptors (name + human description + §8.5 capability category).
// ---------------------------------------------------------------------------

/// One catalog entry: the audited tool's identity, a plain-language
/// `description`, and the §8.5 capability category the install-time
/// permission summary groups it under.
#[derive(Debug, Clone, Copy)]
pub struct ToolDescriptor {
    pub name: ToolName,
    pub description: &'static str,
    /// The first-party capability category (mirrors the schema `capability` enum).
    pub capability: &'static str,
}

static CATALOG: [ToolDescriptor; 5] = [
    ToolDescriptor {
        name: ToolName::StartTimer,
        description: "Start a named countdown timer; the Rust core owns the countdown. \
                      Args: { label, duration_sec }.",
        capability: "timers",
    },
    ToolDescriptor {
        name: ToolName::ConvertUnits,
        description: "Convert a quantity between units of one domain (mass, volume, or \
                      temperature) using exact, deterministic arithmetic. \
                      Args: { domain, value, from_unit, to_unit }.",
        capability: "unit_conversion",
    },
    ToolDescriptor {
        name: ToolName::ListManage,
        description: "Add, remove, check, uncheck, or replace items in a shared checklist. \
                      Args: { op, item?, items? }.",
        capability: "list_management",
    },
    ToolDescriptor {
        name: ToolName::Calculate,
        description: "Evaluate one deterministic arithmetic operation (add, sub, mul, div) over \
                      two or more numeric operands. No free-form expression evaluation. \
                      Args: { op, operands }.",
        capability: "calculation",
    },
    ToolDescriptor {
        name: ToolName::DateMath,
        description: "Add or subtract a days/hours/minutes delta to an RFC 3339 date-time and \
                      return the resulting instant. Args: { base, op, delta }.",
        capability: "date_math",
    },
];

/// The whole fixed catalog, in schema order.
pub fn catalog() -> &'static [ToolDescriptor] {
    &CATALOG
}

/// The descriptor for a specific tool.
pub fn descriptor(name: ToolName) -> &'static ToolDescriptor {
    let i = match name {
        ToolName::StartTimer => 0,
        ToolName::ConvertUnits => 1,
        ToolName::ListManage => 2,
        ToolName::Calculate => 3,
        ToolName::DateMath => 4,
    };
    &CATALOG[i]
}

// ---------------------------------------------------------------------------
// Typed contracts for the two Phase-1-new tools (`calculate`, `date_math`).
// The P0 three reuse their contracts from `crate::ipc` verbatim.
// ---------------------------------------------------------------------------

/// A single deterministic arithmetic operation. No arbitrary expression eval —
/// the op is a closed enum, the operands a plain number list (§8.5 typed contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalcOp {
    Add,
    Sub,
    Mul,
    Div,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalculateArgs {
    pub op: CalcOp,
    /// Two or more finite operands, folded left-to-right by `op`.
    pub operands: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CalculateResult {
    pub value: f64,
}

/// Whether the delta is added to or subtracted from the base instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateOp {
    Add,
    Sub,
}

/// A signed offset expressed in whole days/hours/minutes; each component
/// defaults to zero. Kept as integer components (not a pre-summed value) so the
/// typed contract mirrors how the model is asked to express it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DateDelta {
    #[serde(default)]
    pub days: i64,
    #[serde(default)]
    pub hours: i64,
    #[serde(default)]
    pub minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateMathArgs {
    /// The base instant as an RFC 3339 date-time (e.g. `2026-07-11T09:00:00Z`).
    pub base: String,
    pub op: DateOp,
    #[serde(default)]
    pub delta: DateDelta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateMathResult {
    /// The resulting instant, RFC 3339, preserving the base's UTC offset.
    pub result: String,
}

// ---------------------------------------------------------------------------
// Typed args / results across the whole catalog.
// ---------------------------------------------------------------------------

/// A parsed, validated call — the output of [`validate_and_parse`], the input
/// to [`execute`] (stateless) or the Tool Runtime (stateful).
#[derive(Debug, Clone)]
pub enum TypedArgs {
    StartTimer(StartTimerArgs),
    ConvertUnits(ConvertUnitsArgs),
    ListManage(ListManageArgs),
    Calculate(CalculateArgs),
    DateMath(DateMathArgs),
}

impl TypedArgs {
    pub fn tool(&self) -> ToolName {
        match self {
            TypedArgs::StartTimer(_) => ToolName::StartTimer,
            TypedArgs::ConvertUnits(_) => ToolName::ConvertUnits,
            TypedArgs::ListManage(_) => ToolName::ListManage,
            TypedArgs::Calculate(_) => ToolName::Calculate,
            TypedArgs::DateMath(_) => ToolName::DateMath,
        }
    }
}

/// A tool's typed result. `ConvertUnits`, `Calculate`, and `DateMath` are
/// produced by [`execute`]; `StartTimer` / `ListManage` are produced by the
/// stateful Tool Runtime (their contract lives here for completeness).
#[derive(Debug, Clone)]
pub enum ToolResult {
    StartTimer(StartTimerResult),
    ConvertUnits(ConvertUnitsResult),
    ListManage(ListManageResult),
    Calculate(CalculateResult),
    DateMath(DateMathResult),
}

// ---------------------------------------------------------------------------
// Structured execution-error semantics (P1-05.4, SPEC §8.4 pt 4).
// ---------------------------------------------------------------------------

/// A structured tool error the turn loop must surface — never silently swallow
/// (SPEC §8.4 pt 4). Three distinct causes so the caller can react precisely:
/// an unknown/unlisted tool ref, malformed/ill-typed arguments (naming the
/// offending `field`), or a runtime execution failure (e.g. divide-by-zero,
/// out-of-range date).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    /// The ref is not in the fixed catalog (rejected — skills cannot invent tools).
    UnknownTool { tool_ref: String },
    /// A required argument is missing or ill-typed; `field` names it.
    InvalidArgs { field: String, reason: String },
    /// The tool ran but failed at execution time (e.g. divide-by-zero).
    ExecutionFailed { reason: String },
}

impl ToolError {
    pub fn unknown_tool(tool_ref: impl Into<String>) -> Self {
        Self::UnknownTool { tool_ref: tool_ref.into() }
    }

    pub fn invalid_args(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::InvalidArgs { field: field.into(), reason: reason.into() }
    }

    pub fn execution_failed(reason: impl Into<String>) -> Self {
        Self::ExecutionFailed { reason: reason.into() }
    }

    /// Map onto the existing IPC error code (ipc.rs), so the turn loop can hand
    /// the failure to the webview over the established wire contract.
    pub fn code(&self) -> ToolCallErrorCode {
        match self {
            Self::UnknownTool { .. } => ToolCallErrorCode::UnknownTool,
            Self::InvalidArgs { .. } => ToolCallErrorCode::InvalidArgs,
            Self::ExecutionFailed { .. } => ToolCallErrorCode::ExecutionError,
        }
    }

    /// The wire-ready `{ code, message }` payload (ipc.rs `ToolCallError`).
    pub fn to_wire(&self) -> ToolCallError {
        ToolCallError { code: self.code(), message: self.to_string() }
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownTool { tool_ref } => {
                write!(f, "unknown tool '{tool_ref}': not in the fixed first-party catalog")
            }
            Self::InvalidArgs { field, reason } => {
                write!(f, "invalid argument '{field}': {reason}")
            }
            Self::ExecutionFailed { reason } => write!(f, "tool execution failed: {reason}"),
        }
    }
}

impl std::error::Error for ToolError {}

// ---------------------------------------------------------------------------
// Registry: resolve a ref, validate + parse raw JSON args into typed args.
// ---------------------------------------------------------------------------

/// Resolve a manifest `ref` string to a catalog tool, or `None` if unlisted.
pub fn lookup(tool_ref: &str) -> Option<ToolName> {
    ToolName::from_ref(tool_ref)
}

/// Resolve a ref, or fail with [`ToolError::UnknownTool`].
pub fn resolve(tool_ref: &str) -> Result<ToolName, ToolError> {
    ToolName::from_ref(tool_ref).ok_or_else(|| ToolError::unknown_tool(tool_ref))
}

/// Resolve `tool_ref` against the fixed catalog and parse+validate `raw` into
/// typed args. Rejects unknown refs ([`ToolError::UnknownTool`]) and bad args
/// ([`ToolError::InvalidArgs`] naming the offending field). This is the audited
/// gate: an arbitrary tool or an ill-typed call never reaches execution.
pub fn validate_and_parse(tool_ref: &str, raw: &Value) -> Result<TypedArgs, ToolError> {
    parse_args(resolve(tool_ref)?, raw)
}

/// Parse+validate raw args for an already-resolved tool.
pub fn parse_args(name: ToolName, raw: &Value) -> Result<TypedArgs, ToolError> {
    Ok(match name {
        ToolName::StartTimer => TypedArgs::StartTimer(parse_start_timer(raw)?),
        ToolName::ConvertUnits => TypedArgs::ConvertUnits(parse_convert_units(raw)?),
        ToolName::ListManage => TypedArgs::ListManage(parse_list_manage(raw)?),
        ToolName::Calculate => TypedArgs::Calculate(parse_calculate(raw)?),
        ToolName::DateMath => TypedArgs::DateMath(parse_date_math(raw)?),
    })
}

// --- per-tool validation (mirrors the P0 arg shapes for the first three) ----

fn parse_start_timer(raw: &Value) -> Result<StartTimerArgs, ToolError> {
    let obj = as_object(raw, "arguments")?;
    let label = req_string(obj, "label")?;
    let duration_sec = req_u32(obj, "duration_sec")?;
    if label.trim().is_empty() {
        return Err(ToolError::invalid_args("label", "must not be empty"));
    }
    if duration_sec == 0 {
        return Err(ToolError::invalid_args("duration_sec", "must be a positive number of seconds"));
    }
    Ok(StartTimerArgs { label, duration_sec })
}

fn parse_convert_units(raw: &Value) -> Result<ConvertUnitsArgs, ToolError> {
    let obj = as_object(raw, "arguments")?;
    let domain: UnitDomain = req_enum(obj, "domain")?;
    let value = req_f64(obj, "value")?;
    let from_unit: UnitId = req_enum(obj, "from_unit")?;
    let to_unit: UnitId = req_enum(obj, "to_unit")?;
    if domain_of(from_unit) != domain {
        return Err(ToolError::invalid_args(
            "from_unit",
            format!("{from_unit:?} does not belong to domain {domain:?}"),
        ));
    }
    if domain_of(to_unit) != domain {
        return Err(ToolError::invalid_args(
            "to_unit",
            format!("{to_unit:?} does not belong to domain {domain:?}"),
        ));
    }
    Ok(ConvertUnitsArgs { domain, value, from_unit, to_unit })
}

fn parse_list_manage(raw: &Value) -> Result<ListManageArgs, ToolError> {
    let obj = as_object(raw, "arguments")?;
    let op: ListOp = req_enum(obj, "op")?;
    let item: Option<IngredientItemPatch> = opt_typed(obj, "item")?;
    let items: Option<Vec<IngredientItemPatch>> = opt_typed(obj, "items")?;
    match op {
        ListOp::Add => {
            if item.as_ref().and_then(|i| i.name.as_ref()).is_none() {
                return Err(ToolError::invalid_args("item.name", "required to add an item"));
            }
        }
        ListOp::SetAll => {
            if items.is_none() {
                return Err(ToolError::invalid_args("items", "required for set_all"));
            }
        }
        ListOp::Remove | ListOp::Check | ListOp::Uncheck => {
            if item.as_ref().and_then(|i| i.id.as_ref()).is_none() {
                return Err(ToolError::invalid_args(
                    "item.id",
                    "required to reference an existing item",
                ));
            }
        }
    }
    Ok(ListManageArgs { op, item, items })
}

fn parse_calculate(raw: &Value) -> Result<CalculateArgs, ToolError> {
    let obj = as_object(raw, "arguments")?;
    let op: CalcOp = req_enum(obj, "op")?;
    let operands = req_operands(obj, "operands")?;
    if operands.len() < 2 {
        return Err(ToolError::invalid_args("operands", "expected at least two operands"));
    }
    Ok(CalculateArgs { op, operands })
}

fn parse_date_math(raw: &Value) -> Result<DateMathArgs, ToolError> {
    let obj = as_object(raw, "arguments")?;
    let base = req_string(obj, "base")?;
    if DateTime::parse_from_rfc3339(&base).is_err() {
        return Err(ToolError::invalid_args(
            "base",
            "expected an RFC 3339 date-time (e.g. 2026-07-11T09:00:00Z)",
        ));
    }
    let op: DateOp = req_enum(obj, "op")?;
    let delta_obj = as_object(require(obj, "delta")?, "delta")?;
    let delta = DateDelta {
        days: opt_i64(delta_obj, "days")?,
        hours: opt_i64(delta_obj, "hours")?,
        minutes: opt_i64(delta_obj, "minutes")?,
    };
    Ok(DateMathArgs { base, op, delta })
}

// ---------------------------------------------------------------------------
// Execution. Only the stateless tools run here; the stateful ones are routed
// to the Tool Runtime (guarded so a misrouted call can never silently succeed).
// ---------------------------------------------------------------------------

/// True for tools whose effect lives in the Tool Runtime's `AppState` / shared
/// store (`start_timer`, `list_manage`). The turn loop dispatches these to the
/// runtime; [`execute`] handles only the stateless remainder.
pub fn is_stateful(name: ToolName) -> bool {
    matches!(name, ToolName::StartTimer | ToolName::ListManage)
}

/// Execute a validated call. The three STATELESS tools run purely and return
/// `Ok(result)` or a structured `Err(ToolError::ExecutionFailed)` (e.g.
/// divide-by-zero, out-of-range date) — which the turn loop must surface, never
/// swallow (§8.4 pt 4). The two STATEFUL tools cannot run in the pure catalog;
/// routing one here is a programming error, guarded with `ExecutionFailed`
/// (dispatch them via [`is_stateful`] to the runtime instead).
pub fn execute(args: &TypedArgs) -> Result<ToolResult, ToolError> {
    match args {
        TypedArgs::ConvertUnits(a) => run_convert_units(a).map(ToolResult::ConvertUnits),
        TypedArgs::Calculate(a) => run_calculate(a).map(ToolResult::Calculate),
        TypedArgs::DateMath(a) => run_date_math(a).map(ToolResult::DateMath),
        TypedArgs::StartTimer(_) | TypedArgs::ListManage(_) => Err(ToolError::execution_failed(
            format!(
                "'{}' is a stateful tool; execute it through the Tool Runtime, not the pure catalog",
                args.tool()
            ),
        )),
    }
}

fn run_convert_units(a: &ConvertUnitsArgs) -> Result<ConvertUnitsResult, ToolError> {
    // `validate_and_parse` already enforced domain membership; the Option
    // unwraps below are a defensive backstop for direct callers.
    let value = match a.domain {
        UnitDomain::Mass => {
            let from = mass_to_grams(a.from_unit)
                .ok_or_else(|| ToolError::execution_failed("from_unit is not a mass unit"))?;
            let to = mass_to_grams(a.to_unit)
                .ok_or_else(|| ToolError::execution_failed("to_unit is not a mass unit"))?;
            a.value * from / to
        }
        UnitDomain::Volume => {
            let from = volume_to_ml(a.from_unit)
                .ok_or_else(|| ToolError::execution_failed("from_unit is not a volume unit"))?;
            let to = volume_to_ml(a.to_unit)
                .ok_or_else(|| ToolError::execution_failed("to_unit is not a volume unit"))?;
            a.value * from / to
        }
        UnitDomain::Temperature => match (a.from_unit, a.to_unit) {
            (x, y) if x == y => a.value,
            (UnitId::C, UnitId::F) => a.value * 9.0 / 5.0 + 32.0,
            (UnitId::F, UnitId::C) => (a.value - 32.0) * 5.0 / 9.0,
            _ => return Err(ToolError::execution_failed("unsupported temperature units")),
        },
    };
    // Match the P0 rounding (6 decimals) so the two engines agree exactly.
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    Ok(ConvertUnitsResult { value: rounded, unit: a.to_unit })
}

fn run_calculate(a: &CalculateArgs) -> Result<CalculateResult, ToolError> {
    // `parse_calculate` guarantees >= 2 finite operands.
    let mut acc = a.operands[0];
    for &x in &a.operands[1..] {
        acc = match a.op {
            CalcOp::Add => acc + x,
            CalcOp::Sub => acc - x,
            CalcOp::Mul => acc * x,
            CalcOp::Div => {
                if x == 0.0 {
                    return Err(ToolError::execution_failed("division by zero"));
                }
                acc / x
            }
        };
    }
    if !acc.is_finite() {
        return Err(ToolError::execution_failed(format!("result is not a finite number ({acc})")));
    }
    Ok(CalculateResult { value: acc })
}

fn run_date_math(a: &DateMathArgs) -> Result<DateMathResult, ToolError> {
    let base = DateTime::parse_from_rfc3339(&a.base)
        .map_err(|e| ToolError::invalid_args("base", format!("not an RFC 3339 date-time: {e}")))?;

    // Fold the delta into total minutes with checked i64 arithmetic so a wild
    // delta is a clean execution error, not a panic.
    let total_minutes = a
        .delta
        .days
        .checked_mul(24 * 60)
        .and_then(|d| a.delta.hours.checked_mul(60).and_then(|h| d.checked_add(h)))
        .and_then(|dh| dh.checked_add(a.delta.minutes))
        .ok_or_else(|| ToolError::execution_failed("delta is out of range"))?;

    let span = Duration::try_minutes(total_minutes)
        .ok_or_else(|| ToolError::execution_failed("delta is out of range"))?;

    let out = match a.op {
        DateOp::Add => base.checked_add_signed(span),
        DateOp::Sub => base.checked_sub_signed(span),
    }
    .ok_or_else(|| ToolError::execution_failed("resulting date is out of range"))?;

    Ok(DateMathResult { result: out.to_rfc3339() })
}

// ---------------------------------------------------------------------------
// Deterministic unit conversion (MIRRORS tools.rs::unit_math, which mirrors
// client/web/.../unit-math.ts — same exact constants; change all three together).
// Re-implemented here rather than imported so this module stays free of the
// Tauri coupling tools.rs carries.
// ---------------------------------------------------------------------------

fn mass_to_grams(u: UnitId) -> Option<f64> {
    match u {
        UnitId::G => Some(1.0),
        UnitId::Kg => Some(1000.0),
        UnitId::Oz => Some(28.349_523_125), // exact: international avoirdupois ounce
        UnitId::Lb => Some(453.592_37),      // exact: international avoirdupois pound
        _ => None,
    }
}

fn volume_to_ml(u: UnitId) -> Option<f64> {
    match u {
        UnitId::Ml => Some(1.0),
        UnitId::L => Some(1000.0),
        UnitId::Tsp => Some(4.928_921_593_75),   // exact: US legal teaspoon
        UnitId::Tbsp => Some(14.786_764_781_25), // exact: 3 tsp
        UnitId::FlOz => Some(29.573_529_562_5),  // exact: US fluid ounce
        UnitId::Cup => Some(236.588_236_5),      // exact: US legal cup (8 US fl oz)
        _ => None,
    }
}

fn domain_of(u: UnitId) -> UnitDomain {
    match u {
        UnitId::G | UnitId::Kg | UnitId::Oz | UnitId::Lb => UnitDomain::Mass,
        UnitId::Ml | UnitId::L | UnitId::Tsp | UnitId::Tbsp | UnitId::FlOz | UnitId::Cup => {
            UnitDomain::Volume
        }
        UnitId::C | UnitId::F => UnitDomain::Temperature,
    }
}

// ---------------------------------------------------------------------------
// Raw-JSON argument getters. Each names the offending `field` so a bad call
// yields a precise `InvalidArgs` (P1-05.4) — for missing AND ill-typed fields.
// Unknown extra fields are ignored, matching the P0 tools' leniency.
// ---------------------------------------------------------------------------

fn as_object<'a>(raw: &'a Value, field: &str) -> Result<&'a Map<String, Value>, ToolError> {
    raw.as_object().ok_or_else(|| ToolError::invalid_args(field, "expected a JSON object"))
}

fn require<'a>(obj: &'a Map<String, Value>, field: &str) -> Result<&'a Value, ToolError> {
    obj.get(field).ok_or_else(|| ToolError::invalid_args(field, "required field is missing"))
}

fn req_string(obj: &Map<String, Value>, field: &str) -> Result<String, ToolError> {
    match require(obj, field)? {
        Value::String(s) => Ok(s.clone()),
        _ => Err(ToolError::invalid_args(field, "expected a string")),
    }
}

fn req_f64(obj: &Map<String, Value>, field: &str) -> Result<f64, ToolError> {
    require(obj, field)?
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| ToolError::invalid_args(field, "expected a finite number"))
}

fn req_u32(obj: &Map<String, Value>, field: &str) -> Result<u32, ToolError> {
    let n = require(obj, field)?
        .as_u64()
        .ok_or_else(|| ToolError::invalid_args(field, "expected a non-negative integer"))?;
    u32::try_from(n).map_err(|_| ToolError::invalid_args(field, "value exceeds the u32 range"))
}

fn opt_i64(obj: &Map<String, Value>, field: &str) -> Result<i64, ToolError> {
    match obj.get(field) {
        None | Some(Value::Null) => Ok(0),
        Some(v) => v.as_i64().ok_or_else(|| ToolError::invalid_args(field, "expected an integer")),
    }
}

fn req_enum<T: serde::de::DeserializeOwned>(
    obj: &Map<String, Value>,
    field: &str,
) -> Result<T, ToolError> {
    let v = require(obj, field)?;
    serde_json::from_value::<T>(v.clone())
        .map_err(|e| ToolError::invalid_args(field, format!("invalid value: {e}")))
}

fn opt_typed<T: serde::de::DeserializeOwned>(
    obj: &Map<String, Value>,
    field: &str,
) -> Result<Option<T>, ToolError> {
    match obj.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value::<T>(v.clone())
            .map(Some)
            .map_err(|e| ToolError::invalid_args(field, format!("invalid value: {e}"))),
    }
}

fn req_operands(obj: &Map<String, Value>, field: &str) -> Result<Vec<f64>, ToolError> {
    let arr = require(obj, field)?
        .as_array()
        .ok_or_else(|| ToolError::invalid_args(field, "expected an array of numbers"))?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, e) in arr.iter().enumerate() {
        let n = e
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or_else(|| ToolError::invalid_args(format!("{field}[{i}]"), "expected a finite number"))?;
        out.push(n);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The `field` an `InvalidArgs` names (panics on any other variant).
    fn field_of(e: &ToolError) -> String {
        match e {
            ToolError::InvalidArgs { field, .. } => field.clone(),
            other => panic!("expected InvalidArgs, got {other:?}"),
        }
    }

    // --- catalog + name resolution -----------------------------------------

    #[test]
    fn catalog_is_exactly_the_five_schema_tools() {
        let names: Vec<ToolName> = catalog().iter().map(|d| d.name).collect();
        assert_eq!(names, ToolName::ALL.to_vec());
        assert_eq!(catalog().len(), 5);
        // every descriptor round-trips through `descriptor`
        for &n in &ToolName::ALL {
            assert_eq!(descriptor(n).name, n);
            assert!(!descriptor(n).description.is_empty());
        }
    }

    #[test]
    fn tool_name_serde_and_ref_are_snake_case() {
        assert_eq!(serde_json::to_value(ToolName::DateMath).unwrap(), json!("date_math"));
        assert_eq!(
            serde_json::from_value::<ToolName>(json!("convert_units")).unwrap(),
            ToolName::ConvertUnits
        );
        assert_eq!(ToolName::ListManage.to_string(), "list_manage");
        assert_eq!(ToolName::from_ref("start_timer"), Some(ToolName::StartTimer));
        assert_eq!(ToolName::from_ref("calculate"), Some(ToolName::Calculate));
    }

    #[test]
    fn unknown_tool_ref_is_rejected() {
        assert!(lookup("teleport").is_none());
        assert!(matches!(resolve("teleport"), Err(ToolError::UnknownTool { .. })));
        let e = validate_and_parse("teleport", &json!({})).unwrap_err();
        assert!(matches!(e, ToolError::UnknownTool { .. }));
        // a real-but-P0-only name spelled wrong is still unknown to the catalog
        assert!(lookup("startTimer").is_none());
    }

    // --- start_timer -------------------------------------------------------

    #[test]
    fn start_timer_accepts_good_args() {
        let a = validate_and_parse("start_timer", &json!({"label":"pasta","duration_sec":480}))
            .unwrap();
        match a {
            TypedArgs::StartTimer(s) => {
                assert_eq!(s.label, "pasta");
                assert_eq!(s.duration_sec, 480);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn start_timer_rejects_bad_args_naming_the_field() {
        // missing label
        let e = validate_and_parse("start_timer", &json!({"duration_sec":30})).unwrap_err();
        assert_eq!(field_of(&e), "label");
        // empty label
        let e = validate_and_parse("start_timer", &json!({"label":"  ","duration_sec":30}))
            .unwrap_err();
        assert_eq!(field_of(&e), "label");
        // zero duration
        let e = validate_and_parse("start_timer", &json!({"label":"x","duration_sec":0}))
            .unwrap_err();
        assert_eq!(field_of(&e), "duration_sec");
        // wrong-typed duration (string instead of integer)
        let e = validate_and_parse("start_timer", &json!({"label":"x","duration_sec":"soon"}))
            .unwrap_err();
        assert_eq!(field_of(&e), "duration_sec");
        // args not an object at all
        let e = validate_and_parse("start_timer", &json!("nope")).unwrap_err();
        assert_eq!(field_of(&e), "arguments");
    }

    // --- convert_units -----------------------------------------------------

    #[test]
    fn convert_units_domain_handling_and_execution() {
        // exact mass conversion
        let a =
            validate_and_parse("convert_units", &json!({"domain":"mass","value":1.0,"from_unit":"kg","to_unit":"g"}))
                .unwrap();
        match execute(&a).unwrap() {
            ToolResult::ConvertUnits(c) => {
                assert_eq!(c.value, 1000.0);
                assert_eq!(c.unit, UnitId::G);
            }
            other => panic!("wrong result: {other:?}"),
        }
        // temperature branch
        let a = validate_and_parse(
            "convert_units",
            &json!({"domain":"temperature","value":100.0,"from_unit":"c","to_unit":"f"}),
        )
        .unwrap();
        match execute(&a).unwrap() {
            ToolResult::ConvertUnits(c) => assert_eq!(c.value, 212.0),
            other => panic!("wrong result: {other:?}"),
        }
    }

    #[test]
    fn convert_units_rejects_cross_domain_and_bad_units() {
        // to_unit not in the declared domain
        let e = validate_and_parse(
            "convert_units",
            &json!({"domain":"mass","value":1.0,"from_unit":"g","to_unit":"ml"}),
        )
        .unwrap_err();
        assert_eq!(field_of(&e), "to_unit");
        // from_unit not in the declared domain
        let e = validate_and_parse(
            "convert_units",
            &json!({"domain":"mass","value":1.0,"from_unit":"c","to_unit":"g"}),
        )
        .unwrap_err();
        assert_eq!(field_of(&e), "from_unit");
        // unknown unit token
        let e = validate_and_parse(
            "convert_units",
            &json!({"domain":"mass","value":1.0,"from_unit":"parsec","to_unit":"g"}),
        )
        .unwrap_err();
        assert_eq!(field_of(&e), "from_unit");
    }

    // --- list_manage -------------------------------------------------------

    #[test]
    fn list_manage_validates_per_op() {
        // good add
        let a = validate_and_parse("list_manage", &json!({"op":"add","item":{"name":"flour"}}))
            .unwrap();
        assert!(matches!(a, TypedArgs::ListManage(_)));
        // add without a name
        let e = validate_and_parse("list_manage", &json!({"op":"add","item":{"qty":2}}))
            .unwrap_err();
        assert_eq!(field_of(&e), "item.name");
        // set_all without items
        let e = validate_and_parse("list_manage", &json!({"op":"set_all"})).unwrap_err();
        assert_eq!(field_of(&e), "items");
        // remove without an id
        let e = validate_and_parse("list_manage", &json!({"op":"remove","item":{"name":"x"}}))
            .unwrap_err();
        assert_eq!(field_of(&e), "item.id");
        // unknown op
        let e = validate_and_parse("list_manage", &json!({"op":"frobnicate"})).unwrap_err();
        assert_eq!(field_of(&e), "op");
    }

    // --- calculate ---------------------------------------------------------

    #[test]
    fn calculate_executes_each_op() {
        let cases = [
            (json!({"op":"add","operands":[2.0,3.0,4.0]}), 9.0),
            (json!({"op":"sub","operands":[10.0,3.0,2.0]}), 5.0),
            (json!({"op":"mul","operands":[2.0,3.0,4.0]}), 24.0),
            (json!({"op":"div","operands":[100.0,2.0,5.0]}), 10.0),
        ];
        for (args, expected) in cases {
            let a = validate_and_parse("calculate", &args).unwrap();
            match execute(&a).unwrap() {
                ToolResult::Calculate(c) => assert_eq!(c.value, expected),
                other => panic!("wrong result: {other:?}"),
            }
        }
    }

    #[test]
    fn calculate_divide_by_zero_is_execution_failed() {
        let a = validate_and_parse("calculate", &json!({"op":"div","operands":[1.0,0.0]})).unwrap();
        let e = execute(&a).unwrap_err();
        assert!(matches!(e, ToolError::ExecutionFailed { .. }));
    }

    #[test]
    fn calculate_rejects_bad_operands() {
        // fewer than two operands
        let e = validate_and_parse("calculate", &json!({"op":"add","operands":[1.0]}))
            .unwrap_err();
        assert_eq!(field_of(&e), "operands");
        // not an array
        let e = validate_and_parse("calculate", &json!({"op":"add","operands":5})).unwrap_err();
        assert_eq!(field_of(&e), "operands");
        // a non-numeric element (field names the offending index)
        let e = validate_and_parse("calculate", &json!({"op":"add","operands":[1.0,"x"]}))
            .unwrap_err();
        assert_eq!(field_of(&e), "operands[1]");
    }

    // --- date_math ---------------------------------------------------------

    #[test]
    fn date_math_adds_and_subtracts() {
        let a = validate_and_parse(
            "date_math",
            &json!({"base":"2026-07-11T09:00:00Z","op":"add","delta":{"hours":2,"minutes":30}}),
        )
        .unwrap();
        match execute(&a).unwrap() {
            ToolResult::DateMath(d) => assert!(
                d.result.starts_with("2026-07-11T11:30:00"),
                "got {}",
                d.result
            ),
            other => panic!("wrong result: {other:?}"),
        }

        let a = validate_and_parse(
            "date_math",
            &json!({"base":"2026-07-11T09:00:00Z","op":"sub","delta":{"days":1}}),
        )
        .unwrap();
        match execute(&a).unwrap() {
            ToolResult::DateMath(d) => assert!(
                d.result.starts_with("2026-07-10T09:00:00"),
                "got {}",
                d.result
            ),
            other => panic!("wrong result: {other:?}"),
        }
    }

    #[test]
    fn date_math_rejects_bad_base_and_missing_delta() {
        let e = validate_and_parse(
            "date_math",
            &json!({"base":"not-a-date","op":"add","delta":{"days":1}}),
        )
        .unwrap_err();
        assert_eq!(field_of(&e), "base");

        let e =
            validate_and_parse("date_math", &json!({"base":"2026-07-11T09:00:00Z","op":"add"}))
                .unwrap_err();
        assert_eq!(field_of(&e), "delta");
    }

    #[test]
    fn date_math_out_of_range_is_execution_failed() {
        let a = validate_and_parse(
            "date_math",
            &json!({"base":"2026-07-11T09:00:00Z","op":"add","delta":{"days": i64::MAX}}),
        )
        .unwrap();
        let e = execute(&a).unwrap_err();
        assert!(matches!(e, ToolError::ExecutionFailed { .. }));
    }

    // --- execution routing + error semantics -------------------------------

    #[test]
    fn stateful_tools_are_flagged_and_guarded() {
        assert!(is_stateful(ToolName::StartTimer));
        assert!(is_stateful(ToolName::ListManage));
        assert!(!is_stateful(ToolName::Calculate));
        // executing a stateful tool through the pure catalog is a guarded error
        let a = validate_and_parse("start_timer", &json!({"label":"x","duration_sec":10})).unwrap();
        assert!(matches!(execute(&a), Err(ToolError::ExecutionFailed { .. })));
    }

    #[test]
    fn tool_error_maps_to_the_ipc_wire_codes() {
        // ToolCallErrorCode has no PartialEq (ipc.rs), so match on the variant.
        assert!(matches!(ToolError::unknown_tool("x").code(), ToolCallErrorCode::UnknownTool));
        assert!(matches!(ToolError::invalid_args("f", "r").code(), ToolCallErrorCode::InvalidArgs));
        assert!(matches!(
            ToolError::execution_failed("r").code(),
            ToolCallErrorCode::ExecutionError
        ));
        let wire = ToolError::invalid_args("label", "must not be empty").to_wire();
        assert!(matches!(wire.code, ToolCallErrorCode::InvalidArgs));
        assert!(wire.message.contains("label"));
        // Display is non-empty and Error-compatible
        let _: &dyn std::error::Error = &ToolError::execution_failed("boom");
    }
}
