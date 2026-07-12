#![allow(dead_code)] // Phase-1 install-time validator; wired into the install lifecycle in a later ticket.

//! Client-side manifest validation & normalization (P1-03.1, SPEC §8.2 / §9.2).
//!
//! The desktop client re-validates a skill manifest **offline, before install**:
//! it cannot trust the package, so it repeats the structural + cross-field checks
//! the certification pipeline (P1-20) already ran, then normalizes the shorthand
//! authoring form into the fully-populated **canonical** manifest the renderer and
//! composition core consume.
//!
//! This module is deliberately self-contained. It does NOT reuse
//! `orchestrator::SkillManifest` — that is only the *merge-only subset* the
//! composer needs, not the full contract. Here we validate the RAW manifest as a
//! [`serde_json::Value`] against the authoritative schema
//! (contracts/skill-manifest.schema.json) and produce our own full
//! [`CanonicalManifest`] view.
//!
//! Two things are enforced, matching the two certification gates:
//!  - **Structural** (mirrors the JSON Schema): required fields; the CLOSED sets
//!    for tool refs / capabilities / widget types / categories / enums; sanitized
//!    relative-SVG asset paths (no remote URLs, no non-`.svg`); well-formed semver;
//!    the free-vs-paid pricing rule.
//!  - **Referential integrity** (mirrors `ReferentialIntegrityCheck.java`): every
//!    panel `binds_tool` names a declared tool; every `binds_state` and every tool
//!    `reads_state`/`writes_state` names a declared `shared_state` slot; panel ids
//!    are unique; `localization.default_locale` is a declared string locale.
//!
//! Pure Rust (serde / serde_json only), so it unit-tests standalone
//! (`cargo test --no-default-features --features mock-inference`).
//!
//! ## Normalization (§8.2 / §9.2)
//! Shorthand collapses into canonical form on load: pricing `price_usd` →
//! `price{amount_minor,currency}`; inline panel props → `props{}`; string emits →
//! `{name,to_chat}`; and the omitted defaults are filled
//! (`manifest_version="1.0"`, `status="published"`, `persona.role="primary_eligible"`,
//! `compatibility.combine_priority=50`, `localization.unit_system_default="auto"`,
//! panel `min_widget_version="1.0"`, and per-widget-type `region`/`emits` defaults).
//!
//! ## Assumptions (documented, since the schema does not enumerate them)
//!  - **Per-widget-type default `region`, default event set, and `to_chat`
//!    default** are defined here ([`default_region`] / [`default_event_names`] /
//!    [`default_to_chat`]). The schema/SPEC name these defaults but do not tabulate
//!    them; the values chosen match the canonical `cooking-assistant` fixture
//!    (timer_stack/editable_list → `side`, segmented_toggle → `bottom`;
//!    `timer_finished` posts to chat, `item_checked`/`unit_system_changed` do not).
//!  - **Default panel `priority` = 50** when omitted (the schema says
//!    "declared/inherited"; 50 is the neutral middle of the 0..100 range).
//!  - **Slot-schema strings** are checked only for the closed-language *shape*
//!    (`scalar<…>` / `list<…>` / `record<…>`); their full parsing and the
//!    `list<item>` record expansion are owned by `shared_state.rs` (P1-04.4), so we
//!    carry the schema string through verbatim rather than re-expand it here.
//!  - The certification-only *warnings* (`icon_not_in_assets`, `cost_estimate`
//!    count mismatches) are NOT install-time hard failures and are out of scope for
//!    this offline gate; only the error-level referential checks are enforced.

use std::collections::HashSet;
use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// Closed sets, embedded from contracts/skill-manifest.schema.json. These ARE the
// safety backbone (§8.5 / §9.1): a value outside its set fails validation.
// ---------------------------------------------------------------------------

/// The fixed, first-party, audited tool catalog (`$defs/toolRef`).
pub const TOOL_REFS: [&str; 5] =
    ["start_timer", "convert_units", "list_manage", "calculate", "date_math"];

/// The first-party tool CATEGORIES (`$defs/capability`). Deliberately excludes
/// network / filesystem / system — no such capability exists for v1 skills.
pub const CAPABILITIES: [&str; 5] =
    ["timers", "unit_conversion", "list_management", "calculation", "date_math"];

/// The v1 core widget library (`$defs/widgetType`). `chart`/`sparkline`/`map` are
/// Phase-2 and intentionally absent.
pub const WIDGET_TYPES: [&str; 14] = [
    "chat",
    "timer_stack",
    "editable_list",
    "segmented_toggle",
    "switch",
    "key_value_panel",
    "slider",
    "stepper",
    "table",
    "quick_actions",
    "media_note",
    "tabs",
    "progress",
    "date_time_picker",
];

/// The curated marketplace taxonomy (`properties/category`).
pub const CATEGORIES: [&str; 9] = [
    "Home & Lifestyle",
    "Cooking",
    "Travel",
    "Home & DIY",
    "Nutrition",
    "Budgeting",
    "Study & Reading",
    "Productivity",
    "Other",
];

pub const MODEL_TIERS: [&str; 2] = ["small", "mid"];
pub const REGIONS: [&str; 3] = ["side", "bottom", "inline"];
pub const ACCESS_MODES: [&str; 2] = ["read", "read_write"];
pub const ROLES: [&str; 2] = ["primary_eligible", "secondary_only"];
pub const STATUSES: [&str; 3] = ["published", "deprecated", "withdrawn"];
pub const UNIT_SYSTEMS: [&str; 3] = ["US", "Metric", "auto"];
pub const MANIFEST_VERSIONS: [&str; 1] = ["1.0"];

/// The canonical (non-`props`) top-level keys of a widget/panel declaration.
const CANONICAL_PANEL_KEYS: [&str; 10] = [
    "type",
    "id",
    "title",
    "region",
    "priority",
    "props",
    "binds_state",
    "binds_tool",
    "emits",
    "min_widget_version",
];

/// Default placement priority for a panel that omits `priority` (§9.5).
const DEFAULT_PRIORITY: i64 = 50;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// A machine-readable failure code. The four cross-field codes
/// (`unknown_tool_ref`, `unknown_state_ref`, `duplicate_panel_id`,
/// `undeclared_default_locale`) mirror `ReferentialIntegrityCheck.java` verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    MissingField,
    InvalidType,
    InvalidEnum,
    InvalidLength,
    OutOfRange,
    InvalidSemver,
    InvalidFormat,
    InvalidAssetPath,
    InvalidSlotSchema,
    InvalidPricing,
    UnknownToolRef,
    UnknownCapability,
    UnknownWidgetType,
    UnknownStateRef,
    UnknownProperty,
    DuplicatePanelId,
    UndeclaredDefaultLocale,
}

impl Code {
    /// The stable snake_case string used in logs and cross-tool parity.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::MissingField => "missing_field",
            Code::InvalidType => "invalid_type",
            Code::InvalidEnum => "invalid_enum",
            Code::InvalidLength => "invalid_length",
            Code::OutOfRange => "out_of_range",
            Code::InvalidSemver => "invalid_semver",
            Code::InvalidFormat => "invalid_format",
            Code::InvalidAssetPath => "invalid_asset_path",
            Code::InvalidSlotSchema => "invalid_slot_schema",
            Code::InvalidPricing => "invalid_pricing",
            Code::UnknownToolRef => "unknown_tool_ref",
            Code::UnknownCapability => "unknown_capability",
            Code::UnknownWidgetType => "unknown_widget_type",
            Code::UnknownStateRef => "unknown_state_ref",
            Code::UnknownProperty => "unknown_property",
            Code::DuplicatePanelId => "duplicate_panel_id",
            Code::UndeclaredDefaultLocale => "undeclared_default_locale",
        }
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A single validation failure: a stable [`Code`], a human `message`, and an
/// RFC 6901 JSON `pointer` into the offending manifest location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub code: Code,
    pub message: String,
    pub pointer: String,
}

impl ValidationIssue {
    fn new(code: Code, message: impl Into<String>, pointer: impl Into<String>) -> Self {
        Self { code, message: message.into(), pointer: pointer.into() }
    }
}

impl fmt::Display for ValidationIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ptr = if self.pointer.is_empty() { "/" } else { &self.pointer };
        write!(f, "[{}] {}: {}", self.code, ptr, self.message)
    }
}

// ---------------------------------------------------------------------------
// The canonical manifest — the fully-populated, normalized view produced on a
// successful validate. Serializes back to the canonical JSON shape.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CanonicalManifest {
    pub manifest_version: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub version: String,
    pub status: String,
    pub category: String,
    pub min_app_version: String,
    pub requirements: Requirements,
    pub pricing: Pricing,
    pub persona: Persona,
    pub capabilities: Vec<String>,
    pub tools: Vec<CanonicalTool>,
    pub shared_state: Vec<SharedStateSlot>,
    pub ui: Ui,
    pub resources: Resources,
    pub localization: Localization,
    pub compatibility: Compatibility,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_estimate: Option<CostEstimate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_key_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Requirements {
    pub min_model_tier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_params_b: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_ram_gb: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pricing {
    pub free: bool,
    /// Canonical minor-unit price; `None` for a free skill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<Price>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Price {
    pub amount_minor: i64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Persona {
    pub role: String,
    pub system_prompt: String,
    pub compressed_prompt: String,
    pub few_shot: Vec<FewShot>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FewShot {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CanonicalTool {
    #[serde(rename = "ref")]
    pub tool_ref: String,
    pub config: Value,
    pub reads_state: Vec<String>,
    pub writes_state: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updates_widget: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SharedStateSlot {
    pub slot: String,
    pub access: String,
    pub schema: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ui {
    pub panels: Vec<Panel>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Panel {
    #[serde(rename = "type")]
    pub widget_type: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub region: String,
    pub priority: i64,
    pub props: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binds_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binds_tool: Option<String>,
    pub emits: Vec<Emit>,
    pub min_widget_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Emit {
    pub name: String,
    pub to_chat: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Resources {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub assets: Vec<String>,
    pub strings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Localization {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_locale: Option<String>,
    pub unit_system_default: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Compatibility {
    pub conflicts_with: Vec<String>,
    pub combine_priority: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CostEstimate {
    pub prompt_tokens: i64,
    pub tools: i64,
    pub panels: i64,
}

// ---------------------------------------------------------------------------
// Format predicates (hand-rolled to keep the crate on serde/serde_json only —
// no regex dependency). Each mirrors a `$defs` pattern in the schema.
// ---------------------------------------------------------------------------

/// A numeric identifier with no leading zeros: `0` or `[1-9]\d*`.
fn is_num_id(s: &str) -> bool {
    s == "0"
        || (!s.is_empty() && s.as_bytes()[0] != b'0' && s.bytes().all(|b| b.is_ascii_digit()))
}

/// A dot/dash/alphanumeric run: `[0-9A-Za-z.-]+` (semver pre-release / build).
fn is_dot_dash_alnum(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// `$defs/semver`: `MAJOR.MINOR.PATCH` with optional `-prerelease` / `+build`.
fn is_semver(s: &str) -> bool {
    let (rest, build) = match s.split_once('+') {
        Some((r, b)) => (r, Some(b)),
        None => (s, None),
    };
    if let Some(b) = build {
        if !is_dot_dash_alnum(b) {
            return false;
        }
    }
    let (core, pre) = match rest.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (rest, None),
    };
    if let Some(p) = pre {
        if !is_dot_dash_alnum(p) {
            return false;
        }
    }
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| is_num_id(p))
}

/// `$defs/widgetVersion`: `\d+\.\d+(\.\d+)?`.
fn is_widget_version(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    (parts.len() == 2 || parts.len() == 3)
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `$defs/skillId`: kebab-case `[a-z0-9]+(-[a-z0-9]+)*`, length 2..=64.
///
/// `pub` because the `.hpskill` installer (`hpskill.rs`, P1-03.2) reuses it to
/// guard a caller-supplied skill id before it is joined onto the skills dir path
/// (an id is a single path-safe component — no `/`, `..`, or `.`).
pub fn is_skill_id(s: &str) -> bool {
    let n = s.len();
    n >= 2
        && n <= 64
        && s.split('-')
            .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// `$defs/slotName` and `$defs/widgetId`: `[a-z][a-z0-9_]*`, length 1..=48.
fn is_ident_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 48
        && b[0].is_ascii_lowercase()
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

/// `$defs/localeCode`: `[a-z]{2}(-[A-Z]{2})?`.
///
/// `pub` because the `.hpskill` installer (`hpskill.rs`, P1-03.2) reuses it to
/// gate `strings/<locale>.json` entries against the same localized-string rule
/// (P1-03.4) the manifest's `resources.strings` locales are checked with.
pub fn is_locale(s: &str) -> bool {
    let b = s.as_bytes();
    match b.len() {
        2 => b[0].is_ascii_lowercase() && b[1].is_ascii_lowercase(),
        5 => {
            b[0].is_ascii_lowercase()
                && b[1].is_ascii_lowercase()
                && b[2] == b'-'
                && b[3].is_ascii_uppercase()
                && b[4].is_ascii_uppercase()
        }
        _ => false,
    }
}

/// `$defs/svgAssetPath`: package-relative `*.svg` path; forbids remote URLs
/// (no `://`), path traversal (`..`), and any non-`.svg` extension. Length ≤128.
///
/// `pub` because the `.hpskill` installer (`hpskill.rs`, P1-03.2) applies this
/// exact "sanitized-SVG path" rule (P1-03.4) to every `.svg` archive entry, so
/// the bytes extracted to disk obey the same shape the manifest validator pins.
/// The segment charset (`[A-Za-z0-9_-]`) rejects `..`, absolute paths, and `:`,
/// so it doubles as a traversal guard.
pub fn is_svg_asset_path(s: &str) -> bool {
    if s.len() > 128 {
        return false;
    }
    let stem = match s.strip_suffix(".svg") {
        Some(x) => x,
        None => return false,
    };
    !stem.is_empty()
        && stem
            .split('/')
            .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// A currency code: ISO-4217 `[A-Z]{3}`.
fn is_currency(s: &str) -> bool {
    s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())
}

/// The closed-language *shape* for a shared-state slot schema (§8.3.4). We check
/// only the outer form; full parsing lives in `shared_state.rs` (P1-04.4).
fn is_slot_schema_shape(s: &str) -> bool {
    matches!(s, "scalar" | "list" | "record")
        || ((s.starts_with("scalar<") || s.starts_with("list<") || s.starts_with("record<"))
            && s.ends_with('>'))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Validate a raw manifest JSON and, on success, return the fully-populated
/// [`CanonicalManifest`]. On failure returns EVERY issue found (not fail-fast) so
/// the caller can surface a complete report.
pub fn validate(raw: &Value) -> Result<CanonicalManifest, Vec<ValidationIssue>> {
    let obj = match raw.as_object() {
        Some(o) => o,
        None => {
            return Err(vec![ValidationIssue::new(
                Code::InvalidType,
                "manifest root must be a JSON object",
                "",
            )]);
        }
    };
    let mut issues = Vec::new();
    validate_manifest(obj, &mut issues);
    if issues.is_empty() {
        Ok(normalize(obj))
    } else {
        Err(issues)
    }
}

/// Convenience: parse `input` as JSON then [`validate`]. A JSON parse error is
/// reported as a single issue at the document root.
pub fn validate_json(input: &str) -> Result<CanonicalManifest, Vec<ValidationIssue>> {
    match serde_json::from_str::<Value>(input) {
        Ok(v) => validate(&v),
        Err(e) => Err(vec![ValidationIssue::new(
            Code::InvalidType,
            format!("manifest is not valid JSON: {e}"),
            "",
        )]),
    }
}

// ---------------------------------------------------------------------------
// Structural + referential validation
// ---------------------------------------------------------------------------

fn push(issues: &mut Vec<ValidationIssue>, code: Code, msg: impl Into<String>, ptr: impl Into<String>) {
    issues.push(ValidationIssue::new(code, msg, ptr));
}

/// A required string field: reports missing / wrong-type and returns the value.
fn req_string<'a>(
    obj: &'a Map<String, Value>,
    key: &str,
    issues: &mut Vec<ValidationIssue>,
) -> Option<&'a str> {
    match obj.get(key) {
        None => {
            push(issues, Code::MissingField, format!("required field '{key}' is missing"), ptr(key));
            None
        }
        Some(Value::String(s)) => Some(s),
        Some(_) => {
            push(issues, Code::InvalidType, format!("'{key}' must be a string"), ptr(key));
            None
        }
    }
}

/// A JSON pointer for a top-level key.
fn ptr(key: &str) -> String {
    format!("/{key}")
}

fn check_len(
    issues: &mut Vec<ValidationIssue>,
    s: &str,
    min: usize,
    max: usize,
    pointer: &str,
) {
    let n = s.chars().count();
    if n < min {
        push(issues, Code::InvalidLength, format!("must be at least {min} character(s)"), pointer.to_string());
    } else if n > max {
        push(issues, Code::InvalidLength, format!("must be at most {max} character(s)"), pointer.to_string());
    }
}

fn validate_manifest(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    // manifest_version (optional enum).
    if let Some(v) = obj.get("manifest_version") {
        match v.as_str() {
            Some(s) if MANIFEST_VERSIONS.contains(&s) => {}
            Some(s) => push(issues, Code::InvalidEnum, format!("unknown manifest_version '{s}'"), ptr("manifest_version")),
            None => push(issues, Code::InvalidType, "'manifest_version' must be a string", ptr("manifest_version")),
        }
    }

    // id (required skillId).
    if let Some(id) = req_string(obj, "id", issues) {
        if !is_skill_id(id) {
            push(issues, Code::InvalidFormat, format!("id '{id}' is not a kebab-case slug (2..64 chars)"), ptr("id"));
        }
    }

    // name (required, 1..60).
    if let Some(name) = req_string(obj, "name", issues) {
        check_len(issues, name, 1, 60, "/name");
    }

    // summary (optional, ..140).
    if let Some(v) = obj.get("summary") {
        match v.as_str() {
            Some(s) => check_len(issues, s, 0, 140, "/summary"),
            None => push(issues, Code::InvalidType, "'summary' must be a string", ptr("summary")),
        }
    }

    // version (required semver).
    if let Some(ver) = req_string(obj, "version", issues) {
        if !is_semver(ver) {
            push(issues, Code::InvalidSemver, format!("version '{ver}' is not a valid semver"), ptr("version"));
        }
    }

    // status (optional enum).
    if let Some(v) = obj.get("status") {
        match v.as_str() {
            Some(s) if STATUSES.contains(&s) => {}
            Some(s) => push(issues, Code::InvalidEnum, format!("unknown status '{s}'"), ptr("status")),
            None => push(issues, Code::InvalidType, "'status' must be a string", ptr("status")),
        }
    }

    // category (required enum).
    if let Some(cat) = req_string(obj, "category", issues) {
        if !CATEGORIES.contains(&cat) {
            push(issues, Code::InvalidEnum, format!("category '{cat}' is not in the curated taxonomy"), ptr("category"));
        }
    }

    // min_app_version (required semver).
    if let Some(ver) = req_string(obj, "min_app_version", issues) {
        if !is_semver(ver) {
            push(issues, Code::InvalidSemver, format!("min_app_version '{ver}' is not a valid semver"), ptr("min_app_version"));
        }
    }

    validate_requirements(obj, issues);
    validate_pricing(obj, issues);
    validate_persona(obj, issues);
    validate_capabilities(obj, issues);
    validate_tools(obj, issues);
    validate_shared_state(obj, issues);
    validate_resources(obj, issues);
    validate_localization(obj, issues);
    validate_compatibility(obj, issues);
    validate_ui(obj, issues);

    // Cross-field referential integrity (mirrors ReferentialIntegrityCheck.java).
    validate_referential_integrity(obj, issues);
}

fn req_int(v: &Value, min: i64, max: i64, field: &str, pointer: &str, issues: &mut Vec<ValidationIssue>) {
    match v.as_i64() {
        None => push(issues, Code::InvalidType, format!("'{field}' must be an integer"), pointer.to_string()),
        Some(n) if n < min || n > max => {
            push(issues, Code::OutOfRange, format!("'{field}' must be in {min}..={max}"), pointer.to_string())
        }
        Some(_) => {}
    }
}

fn validate_requirements(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let r = match obj.get("requirements") {
        None => {
            push(issues, Code::MissingField, "required field 'requirements' is missing", ptr("requirements"));
            return;
        }
        Some(Value::Object(r)) => r,
        Some(_) => {
            push(issues, Code::InvalidType, "'requirements' must be an object", ptr("requirements"));
            return;
        }
    };
    match r.get("min_model_tier") {
        None => push(issues, Code::MissingField, "required field 'min_model_tier' is missing", "/requirements/min_model_tier"),
        Some(Value::String(s)) if MODEL_TIERS.contains(&s.as_str()) => {}
        Some(Value::String(s)) => push(issues, Code::InvalidEnum, format!("unknown min_model_tier '{s}'"), "/requirements/min_model_tier"),
        Some(_) => push(issues, Code::InvalidType, "'min_model_tier' must be a string", "/requirements/min_model_tier"),
    }
    if let Some(v) = r.get("min_params_b") {
        req_int(v, 1, 100, "min_params_b", "/requirements/min_params_b", issues);
    }
    if let Some(v) = r.get("min_ram_gb") {
        req_int(v, 1, 1024, "min_ram_gb", "/requirements/min_ram_gb", issues);
    }
}

fn validate_pricing(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let p = match obj.get("pricing") {
        None => {
            push(issues, Code::MissingField, "required field 'pricing' is missing", ptr("pricing"));
            return;
        }
        Some(Value::Object(p)) => p,
        Some(_) => {
            push(issues, Code::InvalidType, "'pricing' must be an object", ptr("pricing"));
            return;
        }
    };
    let free = match p.get("free") {
        None => {
            push(issues, Code::MissingField, "required field 'free' is missing", "/pricing/free");
            return;
        }
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            push(issues, Code::InvalidType, "'free' must be a boolean", "/pricing/free");
            return;
        }
    };
    let has_usd = p.contains_key("price_usd");
    let has_price = p.contains_key("price");

    if free && (has_usd || has_price) {
        push(issues, Code::InvalidPricing, "a free skill must not declare a price", ptr("pricing"));
    }
    if !free && !(has_usd ^ has_price) {
        push(issues, Code::InvalidPricing, "a paid skill must declare exactly one of 'price_usd' or 'price'", ptr("pricing"));
    }

    if let Some(v) = p.get("price_usd") {
        match v.as_f64() {
            None => push(issues, Code::InvalidType, "'price_usd' must be a number", "/pricing/price_usd"),
            Some(n) if n <= 0.0 || n > 1000.0 => {
                push(issues, Code::OutOfRange, "'price_usd' must be in (0, 1000]", "/pricing/price_usd")
            }
            Some(_) => {}
        }
    }
    if let Some(v) = p.get("price") {
        match v.as_object() {
            None => push(issues, Code::InvalidType, "'price' must be an object", "/pricing/price"),
            Some(pr) => {
                match pr.get("amount_minor") {
                    None => push(issues, Code::MissingField, "required field 'amount_minor' is missing", "/pricing/price/amount_minor"),
                    Some(a) => match a.as_i64() {
                        Some(n) if n > 0 => {}
                        Some(_) => push(issues, Code::OutOfRange, "'amount_minor' must be > 0", "/pricing/price/amount_minor"),
                        None => push(issues, Code::InvalidType, "'amount_minor' must be an integer", "/pricing/price/amount_minor"),
                    },
                }
                match pr.get("currency") {
                    None => push(issues, Code::MissingField, "required field 'currency' is missing", "/pricing/price/currency"),
                    Some(Value::String(s)) if is_currency(s) => {}
                    Some(Value::String(_)) => push(issues, Code::InvalidFormat, "'currency' must be an ISO-4217 code (3 uppercase letters)", "/pricing/price/currency"),
                    Some(_) => push(issues, Code::InvalidType, "'currency' must be a string", "/pricing/price/currency"),
                }
            }
        }
    }
}

fn validate_persona(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let p = match obj.get("persona") {
        None => {
            push(issues, Code::MissingField, "required field 'persona' is missing", ptr("persona"));
            return;
        }
        Some(Value::Object(p)) => p,
        Some(_) => {
            push(issues, Code::InvalidType, "'persona' must be an object", ptr("persona"));
            return;
        }
    };
    match p.get("system_prompt") {
        None => push(issues, Code::MissingField, "required field 'system_prompt' is missing", "/persona/system_prompt"),
        Some(Value::String(s)) => check_len(issues, s, 1, 16000, "/persona/system_prompt"),
        Some(_) => push(issues, Code::InvalidType, "'system_prompt' must be a string", "/persona/system_prompt"),
    }
    match p.get("compressed_prompt") {
        None => push(issues, Code::MissingField, "required field 'compressed_prompt' is missing", "/persona/compressed_prompt"),
        Some(Value::String(s)) => check_len(issues, s, 1, 400, "/persona/compressed_prompt"),
        Some(_) => push(issues, Code::InvalidType, "'compressed_prompt' must be a string", "/persona/compressed_prompt"),
    }
    if let Some(v) = p.get("role") {
        match v.as_str() {
            Some(s) if ROLES.contains(&s) => {}
            Some(s) => push(issues, Code::InvalidEnum, format!("unknown persona role '{s}'"), "/persona/role"),
            None => push(issues, Code::InvalidType, "'role' must be a string", "/persona/role"),
        }
    }
    if let Some(v) = p.get("few_shot") {
        match v.as_array() {
            None => push(issues, Code::InvalidType, "'few_shot' must be an array", "/persona/few_shot"),
            Some(arr) => {
                for (i, e) in arr.iter().enumerate() {
                    let base = format!("/persona/few_shot/{i}");
                    let Some(eo) = e.as_object() else {
                        push(issues, Code::InvalidType, "few_shot entry must be an object", base);
                        continue;
                    };
                    match eo.get("role").and_then(Value::as_str) {
                        Some(r) if r == "user" || r == "assistant" => {}
                        Some(r) => push(issues, Code::InvalidEnum, format!("few_shot role '{r}' must be 'user' or 'assistant'"), format!("{base}/role")),
                        None => push(issues, Code::MissingField, "few_shot entry needs a 'role'", format!("{base}/role")),
                    }
                    match eo.get("content").and_then(Value::as_str) {
                        Some(c) if !c.is_empty() => {}
                        _ => push(issues, Code::MissingField, "few_shot entry needs non-empty 'content'", format!("{base}/content")),
                    }
                }
            }
        }
    }
}

fn validate_capabilities(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = obj.get("capabilities") else { return };
    let Some(arr) = v.as_array() else {
        push(issues, Code::InvalidType, "'capabilities' must be an array", ptr("capabilities"));
        return;
    };
    for (i, e) in arr.iter().enumerate() {
        let base = format!("/capabilities/{i}");
        match e.as_str() {
            Some(s) if CAPABILITIES.contains(&s) => {}
            Some(s) => push(
                issues,
                Code::UnknownCapability,
                format!("capability '{s}' is not a first-party tool category (no network/file/system capabilities exist for v1 skills)"),
                base,
            ),
            None => push(issues, Code::InvalidType, "capability must be a string", base),
        }
    }
}

fn validate_tools(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = obj.get("tools") else { return };
    let Some(arr) = v.as_array() else {
        push(issues, Code::InvalidType, "'tools' must be an array", ptr("tools"));
        return;
    };
    for (i, t) in arr.iter().enumerate() {
        let base = format!("/tools/{i}");
        let Some(to) = t.as_object() else {
            push(issues, Code::InvalidType, "tool entry must be an object", base);
            continue;
        };
        match to.get("ref").and_then(Value::as_str) {
            Some(r) if TOOL_REFS.contains(&r) => {}
            Some(r) => push(issues, Code::UnknownToolRef, format!("tool ref '{r}' is not in the fixed first-party catalog"), format!("{base}/ref")),
            None => push(issues, Code::MissingField, "tool entry needs a 'ref'", format!("{base}/ref")),
        }
        if let Some(cfg) = to.get("config") {
            if !cfg.is_object() {
                push(issues, Code::InvalidType, "tool 'config' must be an object", format!("{base}/config"));
            }
        }
        validate_slot_ref_array(to.get("reads_state"), &format!("{base}/reads_state"), issues);
        validate_slot_ref_array(to.get("writes_state"), &format!("{base}/writes_state"), issues);
        if let Some(uw) = to.get("updates_widget") {
            match uw.as_str() {
                Some(s) if is_ident_name(s) => {}
                Some(_) => push(issues, Code::InvalidFormat, "'updates_widget' must be a snake_case widget id", format!("{base}/updates_widget")),
                None => push(issues, Code::InvalidType, "'updates_widget' must be a string", format!("{base}/updates_widget")),
            }
        }
    }
}

/// Type/format check for a `reads_state`/`writes_state` array (membership is
/// checked later in the referential pass).
fn validate_slot_ref_array(v: Option<&Value>, pointer: &str, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = v else { return };
    let Some(arr) = v.as_array() else {
        push(issues, Code::InvalidType, "must be an array of slot names", pointer.to_string());
        return;
    };
    for (i, e) in arr.iter().enumerate() {
        match e.as_str() {
            Some(s) if is_ident_name(s) => {}
            Some(_) => push(issues, Code::InvalidFormat, "slot name must be snake_case", format!("{pointer}/{i}")),
            None => push(issues, Code::InvalidType, "slot name must be a string", format!("{pointer}/{i}")),
        }
    }
}

fn validate_shared_state(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = obj.get("shared_state") else { return };
    let Some(arr) = v.as_array() else {
        push(issues, Code::InvalidType, "'shared_state' must be an array", ptr("shared_state"));
        return;
    };
    for (i, s) in arr.iter().enumerate() {
        let base = format!("/shared_state/{i}");
        let Some(so) = s.as_object() else {
            push(issues, Code::InvalidType, "shared_state entry must be an object", base);
            continue;
        };
        match so.get("slot").and_then(Value::as_str) {
            Some(s) if is_ident_name(s) => {}
            Some(_) => push(issues, Code::InvalidFormat, "'slot' must be a snake_case name", format!("{base}/slot")),
            None => push(issues, Code::MissingField, "shared_state entry needs a 'slot'", format!("{base}/slot")),
        }
        match so.get("access").and_then(Value::as_str) {
            Some(a) if ACCESS_MODES.contains(&a) => {}
            Some(a) => push(issues, Code::InvalidEnum, format!("access '{a}' must be 'read' or 'read_write'"), format!("{base}/access")),
            None => push(issues, Code::MissingField, "shared_state entry needs an 'access'", format!("{base}/access")),
        }
        match so.get("schema").and_then(Value::as_str) {
            Some(sc) if is_slot_schema_shape(sc) => {}
            Some(sc) => push(issues, Code::InvalidSlotSchema, format!("schema '{sc}' is not in the closed type language (scalar<…>/list<…>/record<…>)"), format!("{base}/schema")),
            None => push(issues, Code::MissingField, "shared_state entry needs a 'schema'", format!("{base}/schema")),
        }
    }
}

fn validate_resources(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = obj.get("resources") else { return };
    let Some(r) = v.as_object() else {
        push(issues, Code::InvalidType, "'resources' must be an object", ptr("resources"));
        return;
    };
    if let Some(icon) = r.get("icon") {
        match icon.as_str() {
            Some(s) if is_svg_asset_path(s) => {}
            Some(_) => push(issues, Code::InvalidAssetPath, "'icon' must be a package-relative sanitized-SVG path", "/resources/icon"),
            None => push(issues, Code::InvalidType, "'icon' must be a string", "/resources/icon"),
        }
    }
    if let Some(a) = r.get("assets") {
        match a.as_array() {
            None => push(issues, Code::InvalidType, "'assets' must be an array", "/resources/assets"),
            Some(arr) => {
                for (i, e) in arr.iter().enumerate() {
                    match e.as_str() {
                        Some(s) if is_svg_asset_path(s) => {}
                        Some(_) => push(issues, Code::InvalidAssetPath, "asset must be a package-relative sanitized-SVG path (no remote URLs, no non-.svg)", format!("/resources/assets/{i}")),
                        None => push(issues, Code::InvalidType, "asset must be a string", format!("/resources/assets/{i}")),
                    }
                }
            }
        }
    }
    if let Some(st) = r.get("strings") {
        match st.as_array() {
            None => push(issues, Code::InvalidType, "'strings' must be an array", "/resources/strings"),
            Some(arr) => {
                for (i, e) in arr.iter().enumerate() {
                    match e.as_str() {
                        Some(s) if is_locale(s) => {}
                        Some(_) => push(issues, Code::InvalidFormat, "locale must be a BCP-47 code (e.g. 'en', 'en-US')", format!("/resources/strings/{i}")),
                        None => push(issues, Code::InvalidType, "locale must be a string", format!("/resources/strings/{i}")),
                    }
                }
            }
        }
    }
}

fn validate_localization(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = obj.get("localization") else { return };
    let Some(l) = v.as_object() else {
        push(issues, Code::InvalidType, "'localization' must be an object", ptr("localization"));
        return;
    };
    if let Some(dl) = l.get("default_locale") {
        match dl.as_str() {
            Some(s) if is_locale(s) => {}
            Some(_) => push(issues, Code::InvalidFormat, "'default_locale' must be a BCP-47 locale", "/localization/default_locale"),
            None => push(issues, Code::InvalidType, "'default_locale' must be a string", "/localization/default_locale"),
        }
    }
    if let Some(us) = l.get("unit_system_default") {
        match us.as_str() {
            Some(s) if UNIT_SYSTEMS.contains(&s) => {}
            Some(s) => push(issues, Code::InvalidEnum, format!("unit_system_default '{s}' must be US/Metric/auto"), "/localization/unit_system_default"),
            None => push(issues, Code::InvalidType, "'unit_system_default' must be a string", "/localization/unit_system_default"),
        }
    }
}

fn validate_compatibility(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = obj.get("compatibility") else { return };
    let Some(c) = v.as_object() else {
        push(issues, Code::InvalidType, "'compatibility' must be an object", ptr("compatibility"));
        return;
    };
    if let Some(cw) = c.get("conflicts_with") {
        match cw.as_array() {
            None => push(issues, Code::InvalidType, "'conflicts_with' must be an array", "/compatibility/conflicts_with"),
            Some(arr) => {
                for (i, e) in arr.iter().enumerate() {
                    match e.as_str() {
                        Some(s) if is_skill_id(s) => {}
                        Some(_) => push(issues, Code::InvalidFormat, "conflicts_with entry must be a skill id", format!("/compatibility/conflicts_with/{i}")),
                        None => push(issues, Code::InvalidType, "conflicts_with entry must be a string", format!("/compatibility/conflicts_with/{i}")),
                    }
                }
            }
        }
    }
    if let Some(cp) = c.get("combine_priority") {
        req_int(cp, 0, 100, "combine_priority", "/compatibility/combine_priority", issues);
    }
}

fn validate_ui(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    let Some(v) = obj.get("ui") else { return };
    let Some(ui) = v.as_object() else {
        push(issues, Code::InvalidType, "'ui' must be an object", ptr("ui"));
        return;
    };
    let panels = match ui.get("panels") {
        None => {
            push(issues, Code::MissingField, "'ui' requires 'panels'", "/ui/panels");
            return;
        }
        Some(Value::Array(a)) => a,
        Some(_) => {
            push(issues, Code::InvalidType, "'panels' must be an array", "/ui/panels");
            return;
        }
    };
    for (i, p) in panels.iter().enumerate() {
        validate_panel(p, i, issues);
    }
}

fn validate_panel(p: &Value, i: usize, issues: &mut Vec<ValidationIssue>) {
    let base = format!("/ui/panels/{i}");
    let Some(po) = p.as_object() else {
        push(issues, Code::InvalidType, "panel must be an object", base);
        return;
    };

    // type (required, closed set).
    let widget_type = match po.get("type").and_then(Value::as_str) {
        Some(t) if WIDGET_TYPES.contains(&t) => Some(t),
        Some(t) => {
            push(issues, Code::UnknownWidgetType, format!("widget type '{t}' is not in the v1 widget library"), format!("{base}/type"));
            None
        }
        None => {
            push(issues, Code::MissingField, "panel needs a 'type'", format!("{base}/type"));
            None
        }
    };

    // id (required, widgetId).
    match po.get("id").and_then(Value::as_str) {
        Some(s) if is_ident_name(s) => {}
        Some(_) => push(issues, Code::InvalidFormat, "panel 'id' must be a snake_case identifier", format!("{base}/id")),
        None => push(issues, Code::MissingField, "panel needs an 'id'", format!("{base}/id")),
    }

    // title (optional, ..80).
    if let Some(v) = po.get("title") {
        match v.as_str() {
            Some(s) => check_len(issues, s, 0, 80, &format!("{base}/title")),
            None => push(issues, Code::InvalidType, "panel 'title' must be a string", format!("{base}/title")),
        }
    }

    // region (optional enum).
    if let Some(v) = po.get("region") {
        match v.as_str() {
            Some(s) if REGIONS.contains(&s) => {}
            Some(s) => push(issues, Code::InvalidEnum, format!("region '{s}' must be side/bottom/inline"), format!("{base}/region")),
            None => push(issues, Code::InvalidType, "panel 'region' must be a string", format!("{base}/region")),
        }
    }

    // priority (optional int 0..100).
    if let Some(v) = po.get("priority") {
        req_int(v, 0, 100, "priority", &format!("{base}/priority"), issues);
    }

    // props (optional object).
    if let Some(v) = po.get("props") {
        if !v.is_object() {
            push(issues, Code::InvalidType, "panel 'props' must be an object", format!("{base}/props"));
        }
    }

    // binds_state (optional slot name — membership checked in referential pass).
    if let Some(v) = po.get("binds_state") {
        match v.as_str() {
            Some(s) if is_ident_name(s) => {}
            Some(_) => push(issues, Code::InvalidFormat, "'binds_state' must be a snake_case slot name", format!("{base}/binds_state")),
            None => push(issues, Code::InvalidType, "'binds_state' must be a string", format!("{base}/binds_state")),
        }
    }

    // binds_tool (optional — must be a catalog tool; declared-membership in ref pass).
    if let Some(v) = po.get("binds_tool") {
        match v.as_str() {
            Some(s) if TOOL_REFS.contains(&s) => {}
            Some(_) => push(issues, Code::UnknownToolRef, "'binds_tool' is not a catalog tool ref", format!("{base}/binds_tool")),
            None => push(issues, Code::InvalidType, "'binds_tool' must be a string", format!("{base}/binds_tool")),
        }
    }

    // min_widget_version (optional).
    if let Some(v) = po.get("min_widget_version") {
        match v.as_str() {
            Some(s) if is_widget_version(s) => {}
            Some(_) => push(issues, Code::InvalidFormat, "'min_widget_version' must look like '1.0'", format!("{base}/min_widget_version")),
            None => push(issues, Code::InvalidType, "'min_widget_version' must be a string", format!("{base}/min_widget_version")),
        }
    }

    // emits (optional array of string | {name, to_chat?}).
    if let Some(v) = po.get("emits") {
        match v.as_array() {
            None => push(issues, Code::InvalidType, "'emits' must be an array", format!("{base}/emits")),
            Some(arr) => {
                for (j, e) in arr.iter().enumerate() {
                    let ep = format!("{base}/emits/{j}");
                    match e {
                        Value::String(s) => check_len(issues, s, 1, 48, &ep),
                        Value::Object(eo) => {
                            match eo.get("name").and_then(Value::as_str) {
                                Some(n) => check_len(issues, n, 1, 48, &format!("{ep}/name")),
                                None => push(issues, Code::MissingField, "emit entry needs a 'name'", format!("{ep}/name")),
                            }
                            if let Some(tc) = eo.get("to_chat") {
                                if !tc.is_boolean() {
                                    push(issues, Code::InvalidType, "'to_chat' must be a boolean", format!("{ep}/to_chat"));
                                }
                            }
                        }
                        _ => push(issues, Code::InvalidType, "emit entry must be a string or object", ep),
                    }
                }
            }
        }
    }

    // Unknown-property guard (mirrors the schema's `unevaluatedProperties: false`):
    // a top-level panel key must be canonical or a recognized inline shorthand for
    // the declared widget type.
    if let Some(wt) = widget_type {
        let inline = inline_prop_keys(wt);
        for k in po.keys() {
            let k = k.as_str();
            if !CANONICAL_PANEL_KEYS.contains(&k) && !inline.contains(&k) {
                push(issues, Code::UnknownProperty, format!("panel key '{k}' is not valid for widget type '{wt}'"), format!("{base}/{k}"));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Referential integrity (mirrors backend ReferentialIntegrityCheck.java).
// ---------------------------------------------------------------------------

fn validate_referential_integrity(obj: &Map<String, Value>, issues: &mut Vec<ValidationIssue>) {
    // Declared tool refs.
    let declared_tools: HashSet<&str> = obj
        .get("tools")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|t| t.get("ref").and_then(Value::as_str)).collect())
        .unwrap_or_default();

    // Declared shared-state slots.
    let declared_slots: HashSet<&str> = obj
        .get("shared_state")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|s| s.get("slot").and_then(Value::as_str)).collect())
        .unwrap_or_default();

    // Declared string locales.
    let declared_locales: HashSet<&str> = obj
        .get("resources")
        .and_then(|r| r.get("strings"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    // Each tool's reads_state / writes_state must name a declared slot.
    if let Some(arr) = obj.get("tools").and_then(Value::as_array) {
        for (i, t) in arr.iter().enumerate() {
            check_state_refs(t.get("reads_state"), &declared_slots, &format!("/tools/{i}/reads_state"), issues);
            check_state_refs(t.get("writes_state"), &declared_slots, &format!("/tools/{i}/writes_state"), issues);
        }
    }

    // Panels: unique ids; valid tool/state bindings.
    if let Some(arr) = obj.get("ui").and_then(|u| u.get("panels")).and_then(Value::as_array) {
        let mut seen: HashSet<&str> = HashSet::new();
        for (i, p) in arr.iter().enumerate() {
            let base = format!("/ui/panels/{i}");
            if let Some(id) = p.get("id").and_then(Value::as_str) {
                if !seen.insert(id) {
                    push(issues, Code::DuplicatePanelId, format!("panel id '{id}' is not unique"), format!("{base}/id"));
                }
            }
            if let Some(bt) = p.get("binds_tool").and_then(Value::as_str) {
                if !declared_tools.contains(bt) {
                    push(issues, Code::UnknownToolRef, format!("panel binds_tool '{bt}' is not a declared tool"), format!("{base}/binds_tool"));
                }
            }
            if let Some(bs) = p.get("binds_state").and_then(Value::as_str) {
                if !declared_slots.contains(bs) {
                    push(issues, Code::UnknownStateRef, format!("panel binds_state '{bs}' is not a declared shared_state slot"), format!("{base}/binds_state"));
                }
            }
        }
    }

    // localization.default_locale must be a declared string locale (when any declared).
    if let Some(dl) = obj.get("localization").and_then(|l| l.get("default_locale")).and_then(Value::as_str) {
        if !declared_locales.is_empty() && !declared_locales.contains(dl) {
            push(issues, Code::UndeclaredDefaultLocale, format!("localization.default_locale '{dl}' is not in resources.strings"), "/localization/default_locale");
        }
    }
}

fn check_state_refs(
    refs: Option<&Value>,
    declared_slots: &HashSet<&str>,
    pointer: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let Some(arr) = refs.and_then(Value::as_array) else { return };
    for (i, r) in arr.iter().enumerate() {
        if let Some(slot) = r.as_str() {
            if !declared_slots.contains(slot) {
                push(issues, Code::UnknownStateRef, format!("state ref '{slot}' is not a declared shared_state slot"), format!("{pointer}/{i}"));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Per-widget-type defaults (assumptions — see the module header). Only consulted
// during normalization, once the manifest is known valid.
// ---------------------------------------------------------------------------

/// The default layout region for a widget that omits `region` (§9.5).
fn default_region(widget_type: &str) -> &'static str {
    match widget_type {
        "timer_stack" | "editable_list" | "key_value_panel" | "media_note" | "tabs" => "side",
        "segmented_toggle" | "switch" | "slider" | "stepper" | "quick_actions" | "progress"
        | "date_time_picker" => "bottom",
        _ => "inline", // chat, table, and any future default
    }
}

/// Whether events from this widget type post a system line into the transcript by
/// default (§9.3 #4). Time-critical timer completion is the one that does.
fn default_to_chat(widget_type: &str) -> bool {
    matches!(widget_type, "timer_stack")
}

/// The default event set a widget type emits when `emits` is omitted (§9.2).
fn default_event_names(widget_type: &str) -> &'static [&'static str] {
    match widget_type {
        "timer_stack" => &["timer_finished"],
        "editable_list" => &["item_checked"],
        "segmented_toggle" | "switch" | "slider" | "stepper" | "date_time_picker" => &["changed"],
        "quick_actions" => &["action"],
        "progress" => &["complete"],
        _ => &[],
    }
}

/// The inline-shorthand prop keys the schema allows for a widget type; these fold
/// into `props` on load (§9.2).
fn inline_prop_keys(widget_type: &str) -> &'static [&'static str] {
    match widget_type {
        "timer_stack" => &["multi"],
        "editable_list" => &["checkable", "reorderable", "max_items"],
        "segmented_toggle" | "switch" => &["options", "default"],
        "slider" | "stepper" => &["min", "max", "step", "default"],
        "table" => &["columns"],
        "quick_actions" => &["actions"],
        "progress" => &["mode"],
        "date_time_picker" => &["mode", "min", "max"],
        "media_note" => &["image", "body"],
        "tabs" => &["tab_ids"],
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// Normalization: shorthand -> fully-populated canonical. Total & infallible;
// only invoked after `validate` proves the manifest well-formed, so the reads
// below fall back to defaults rather than erroring.
// ---------------------------------------------------------------------------

fn str_or(obj: &Map<String, Value>, key: &str, default: &str) -> String {
    obj.get(key).and_then(Value::as_str).unwrap_or(default).to_string()
}

fn opt_str(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(str::to_string)
}

fn str_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn normalize(obj: &Map<String, Value>) -> CanonicalManifest {
    CanonicalManifest {
        manifest_version: str_or(obj, "manifest_version", "1.0"),
        id: str_or(obj, "id", ""),
        name: str_or(obj, "name", ""),
        summary: opt_str(obj, "summary"),
        version: str_or(obj, "version", ""),
        status: str_or(obj, "status", "published"),
        category: str_or(obj, "category", ""),
        min_app_version: str_or(obj, "min_app_version", ""),
        requirements: normalize_requirements(obj.get("requirements")),
        pricing: normalize_pricing(obj.get("pricing")),
        persona: normalize_persona(obj.get("persona")),
        capabilities: str_array(obj.get("capabilities")),
        tools: normalize_tools(obj.get("tools")),
        shared_state: normalize_slots(obj.get("shared_state")),
        ui: normalize_ui(obj.get("ui")),
        resources: normalize_resources(obj.get("resources")),
        localization: normalize_localization(obj.get("localization")),
        compatibility: normalize_compatibility(obj.get("compatibility")),
        cost_estimate: normalize_cost(obj.get("cost_estimate")),
        signature: opt_str(obj, "signature"),
        signing_key_id: opt_str(obj, "signing_key_id"),
    }
}

fn normalize_requirements(v: Option<&Value>) -> Requirements {
    let o = v.and_then(Value::as_object);
    Requirements {
        min_model_tier: o
            .and_then(|o| o.get("min_model_tier"))
            .and_then(Value::as_str)
            .unwrap_or("small")
            .to_string(),
        min_params_b: o.and_then(|o| o.get("min_params_b")).and_then(Value::as_i64),
        min_ram_gb: o.and_then(|o| o.get("min_ram_gb")).and_then(Value::as_i64),
    }
}

fn normalize_pricing(v: Option<&Value>) -> Pricing {
    let o = v.and_then(Value::as_object);
    let free = o.and_then(|o| o.get("free")).and_then(Value::as_bool).unwrap_or(true);
    if free {
        return Pricing { free: true, price: None };
    }
    if let Some(pr) = o.and_then(|o| o.get("price")).and_then(Value::as_object) {
        Pricing {
            free: false,
            price: Some(Price {
                amount_minor: pr.get("amount_minor").and_then(Value::as_i64).unwrap_or(0),
                currency: pr.get("currency").and_then(Value::as_str).unwrap_or("USD").to_string(),
            }),
        }
    } else if let Some(usd) = o.and_then(|o| o.get("price_usd")).and_then(Value::as_f64) {
        Pricing {
            free: false,
            price: Some(Price { amount_minor: (usd * 100.0).round() as i64, currency: "USD".to_string() }),
        }
    } else {
        Pricing { free: false, price: None }
    }
}

fn normalize_persona(v: Option<&Value>) -> Persona {
    let o = v.and_then(Value::as_object);
    Persona {
        role: o
            .and_then(|o| o.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("primary_eligible")
            .to_string(),
        system_prompt: o.and_then(|o| o.get("system_prompt")).and_then(Value::as_str).unwrap_or("").to_string(),
        compressed_prompt: o
            .and_then(|o| o.get("compressed_prompt"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        few_shot: o
            .and_then(|o| o.get("few_shot"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.as_object())
                    .map(|eo| FewShot {
                        role: eo.get("role").and_then(Value::as_str).unwrap_or("").to_string(),
                        content: eo.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn normalize_tools(v: Option<&Value>) -> Vec<CanonicalTool> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_object)
                .map(|t| CanonicalTool {
                    tool_ref: t.get("ref").and_then(Value::as_str).unwrap_or("").to_string(),
                    config: t.get("config").cloned().unwrap_or_else(|| Value::Object(Map::new())),
                    reads_state: str_array(t.get("reads_state")),
                    writes_state: str_array(t.get("writes_state")),
                    updates_widget: opt_str(t, "updates_widget"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_slots(v: Option<&Value>) -> Vec<SharedStateSlot> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_object)
                .map(|s| SharedStateSlot {
                    slot: s.get("slot").and_then(Value::as_str).unwrap_or("").to_string(),
                    access: s.get("access").and_then(Value::as_str).unwrap_or("read").to_string(),
                    schema: s.get("schema").and_then(Value::as_str).unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_ui(v: Option<&Value>) -> Ui {
    let panels = v
        .and_then(|u| u.get("panels"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_object).map(normalize_panel).collect())
        .unwrap_or_default();
    Ui { panels }
}

fn normalize_panel(p: &Map<String, Value>) -> Panel {
    let widget_type = p.get("type").and_then(Value::as_str).unwrap_or("").to_string();

    // props: start from any canonical props object, then fold inline shorthand
    // keys (canonical `props` values win over an inline duplicate).
    let mut props = p.get("props").and_then(Value::as_object).cloned().unwrap_or_default();
    for &k in inline_prop_keys(&widget_type) {
        if let Some(val) = p.get(k) {
            props.entry(k.to_string()).or_insert_with(|| val.clone());
        }
    }

    Panel {
        region: p
            .get("region")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| default_region(&widget_type).to_string()),
        priority: p.get("priority").and_then(Value::as_i64).unwrap_or(DEFAULT_PRIORITY),
        title: opt_str(p, "title"),
        binds_state: opt_str(p, "binds_state"),
        binds_tool: opt_str(p, "binds_tool"),
        emits: normalize_emits(p.get("emits"), &widget_type),
        min_widget_version: p
            .get("min_widget_version")
            .and_then(Value::as_str)
            .unwrap_or("1.0")
            .to_string(),
        id: p.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        props: Value::Object(props),
        widget_type,
    }
}

fn normalize_emits(v: Option<&Value>, widget_type: &str) -> Vec<Emit> {
    match v.and_then(Value::as_array) {
        None => default_event_names(widget_type)
            .iter()
            .map(|n| Emit { name: (*n).to_string(), to_chat: default_to_chat(widget_type) })
            .collect(),
        Some(arr) => arr
            .iter()
            .filter_map(|e| match e {
                Value::String(s) => Some(Emit { name: s.clone(), to_chat: default_to_chat(widget_type) }),
                Value::Object(o) => o.get("name").and_then(Value::as_str).map(|name| Emit {
                    name: name.to_string(),
                    to_chat: o.get("to_chat").and_then(Value::as_bool).unwrap_or(default_to_chat(widget_type)),
                }),
                _ => None,
            })
            .collect(),
    }
}

fn normalize_resources(v: Option<&Value>) -> Resources {
    let o = v.and_then(Value::as_object);
    Resources {
        icon: o.and_then(|o| opt_str(o, "icon")),
        assets: str_array(o.and_then(|o| o.get("assets"))),
        strings: str_array(o.and_then(|o| o.get("strings"))),
    }
}

fn normalize_localization(v: Option<&Value>) -> Localization {
    let o = v.and_then(Value::as_object);
    Localization {
        default_locale: o.and_then(|o| opt_str(o, "default_locale")),
        unit_system_default: o
            .and_then(|o| o.get("unit_system_default"))
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .to_string(),
    }
}

fn normalize_compatibility(v: Option<&Value>) -> Compatibility {
    let o = v.and_then(Value::as_object);
    Compatibility {
        conflicts_with: str_array(o.and_then(|o| o.get("conflicts_with"))),
        combine_priority: o
            .and_then(|o| o.get("combine_priority"))
            .and_then(Value::as_i64)
            .unwrap_or(50),
    }
}

fn normalize_cost(v: Option<&Value>) -> Option<CostEstimate> {
    let o = v?.as_object()?;
    Some(CostEstimate {
        prompt_tokens: o.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0),
        tools: o.get("tools").and_then(Value::as_i64).unwrap_or(0),
        panels: o.get("panels").and_then(Value::as_i64).unwrap_or(0),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn has(errs: &[ValidationIssue], code: Code) -> bool {
        errs.iter().any(|e| e.code == code)
    }

    /// A minimal manifest carrying exactly the required fields, in shorthand.
    fn minimal() -> Value {
        json!({
            "id": "test-skill",
            "name": "Test",
            "version": "1.0.0",
            "category": "Other",
            "min_app_version": "1.0.0",
            "requirements": { "min_model_tier": "small" },
            "pricing": { "free": true },
            "persona": { "system_prompt": "You are a test.", "compressed_prompt": "Test." }
        })
    }

    /// Apply a mutation to a manifest's root object.
    fn with(mut m: Value, f: impl FnOnce(&mut Map<String, Value>)) -> Value {
        f(m.as_object_mut().unwrap());
        m
    }

    // --- the two reference fixtures validate --------------------------------

    #[test]
    fn kitchen_timer_fixture_validates() {
        let src = include_str!("../../../contracts/examples/kitchen-timer.manifest.json");
        let c = validate_json(src).expect("kitchen-timer must validate");
        assert_eq!(c.id, "kitchen-timer");
        assert!(c.pricing.free);
        assert_eq!(c.pricing.price, None);
        assert_eq!(c.tools.len(), 3);
        assert_eq!(c.ui.panels.len(), 3);
        // shorthand `multi: true` folded into props; region defaulted.
        let timers = c.ui.panels.iter().find(|p| p.id == "timers").unwrap();
        assert_eq!(timers.props, json!({ "multi": true }));
        assert_eq!(timers.region, "side");
        assert_eq!(timers.min_widget_version, "1.0");
    }

    #[test]
    fn cooking_assistant_fixture_validates() {
        let src = include_str!("../../../contracts/examples/cooking-assistant.manifest.json");
        let c = validate_json(src).expect("cooking-assistant must validate");
        assert_eq!(c.id, "cooking-assistant");
        assert!(!c.pricing.free);
        assert_eq!(c.pricing.price, Some(Price { amount_minor: 500, currency: "USD".to_string() }));
        // canonical emits carried through, including the to_chat override.
        let timers = c.ui.panels.iter().find(|p| p.id == "timers").unwrap();
        assert_eq!(timers.emits, vec![Emit { name: "timer_finished".to_string(), to_chat: true }]);
        assert_eq!(c.signing_key_id.as_deref(), Some("hp-pkg-2026a"));
    }

    #[test]
    fn minimal_manifest_is_valid() {
        assert!(validate(&minimal()).is_ok());
    }

    // --- crafted structural defects -----------------------------------------

    #[test]
    fn missing_id_fails_missing_field() {
        let m = with(minimal(), |o| {
            o.remove("id");
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::MissingField));
        assert!(e.iter().any(|i| i.code == Code::MissingField && i.pointer == "/id"));
    }

    #[test]
    fn unknown_tool_ref_fails() {
        let m = with(minimal(), |o| {
            o.insert("tools".to_string(), json!([{ "ref": "teleport" }]));
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::UnknownToolRef));
    }

    #[test]
    fn network_capability_fails() {
        let m = with(minimal(), |o| {
            o.insert("capabilities".to_string(), json!(["network"]));
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::UnknownCapability));
    }

    #[test]
    fn undeclared_binds_tool_fails() {
        // Panel binds a real catalog tool, but the skill declares no tools.
        let m = with(minimal(), |o| {
            o.insert(
                "ui".to_string(),
                json!({ "panels": [{ "type": "timer_stack", "id": "t", "binds_tool": "start_timer" }] }),
            );
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::UnknownToolRef));
        assert!(e.iter().any(|i| i.pointer == "/ui/panels/0/binds_tool"));
    }

    #[test]
    fn undeclared_binds_state_fails() {
        let m = with(minimal(), |o| {
            o.insert(
                "ui".to_string(),
                json!({ "panels": [{ "type": "editable_list", "id": "l", "binds_state": "ingredients" }] }),
            );
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::UnknownStateRef));
    }

    #[test]
    fn undeclared_tool_writes_state_fails() {
        let m = with(minimal(), |o| {
            o.insert(
                "tools".to_string(),
                json!([{ "ref": "list_manage", "writes_state": ["ingredients"] }]),
            );
        });
        let e = validate(&m).unwrap_err();
        assert!(e
            .iter()
            .any(|i| i.code == Code::UnknownStateRef && i.pointer == "/tools/0/writes_state/0"));
    }

    #[test]
    fn bad_semver_fails() {
        let m = with(minimal(), |o| {
            o.insert("version".to_string(), json!("1.2"));
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::InvalidSemver));
    }

    #[test]
    fn remote_asset_fails() {
        let m = with(minimal(), |o| {
            o.insert(
                "resources".to_string(),
                json!({ "assets": ["https://evil.example/x.svg"], "strings": ["en"] }),
            );
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::InvalidAssetPath));
    }

    #[test]
    fn non_svg_and_traversal_assets_fail() {
        let m = with(minimal(), |o| {
            o.insert(
                "resources".to_string(),
                json!({ "assets": ["../secret.svg", "logo.png"], "strings": ["en"] }),
            );
        });
        let e = validate(&m).unwrap_err();
        assert_eq!(e.iter().filter(|i| i.code == Code::InvalidAssetPath).count(), 2);
    }

    #[test]
    fn duplicate_panel_id_fails() {
        let m = with(minimal(), |o| {
            o.insert(
                "ui".to_string(),
                json!({ "panels": [
                    { "type": "timer_stack", "id": "dup" },
                    { "type": "progress", "id": "dup" }
                ] }),
            );
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::DuplicatePanelId));
    }

    #[test]
    fn undeclared_default_locale_fails() {
        let m = with(minimal(), |o| {
            o.insert("resources".to_string(), json!({ "strings": ["en"] }));
            o.insert("localization".to_string(), json!({ "default_locale": "uk" }));
        });
        let e = validate(&m).unwrap_err();
        assert!(has(&e, Code::UndeclaredDefaultLocale));
    }

    #[test]
    fn paid_without_price_fails_and_free_with_price_fails() {
        let paid = with(minimal(), |o| {
            o.insert("pricing".to_string(), json!({ "free": false }));
        });
        assert!(has(&validate(&paid).unwrap_err(), Code::InvalidPricing));

        let free_priced = with(minimal(), |o| {
            o.insert("pricing".to_string(), json!({ "free": true, "price_usd": 5 }));
        });
        assert!(has(&validate(&free_priced).unwrap_err(), Code::InvalidPricing));
    }

    #[test]
    fn unknown_widget_type_and_bad_inline_prop_fail() {
        let bad_type = with(minimal(), |o| {
            o.insert("ui".to_string(), json!({ "panels": [{ "type": "hologram", "id": "h" }] }));
        });
        assert!(has(&validate(&bad_type).unwrap_err(), Code::UnknownWidgetType));

        // `multi` is a timer_stack inline prop, not valid on editable_list.
        let bad_prop = with(minimal(), |o| {
            o.insert(
                "ui".to_string(),
                json!({ "panels": [{ "type": "editable_list", "id": "l", "multi": true }] }),
            );
        });
        assert!(has(&validate(&bad_prop).unwrap_err(), Code::UnknownProperty));
    }

    // --- shorthand -> canonical normalization -------------------------------

    #[test]
    fn shorthand_normalizes_to_canonical() {
        let m = json!({
            "id": "norm-skill",
            "name": "Norm",
            "version": "2.0.0",
            "category": "Cooking",
            "min_app_version": "1.0.0",
            "requirements": { "min_model_tier": "small" },
            "pricing": { "free": false, "price_usd": 5 },
            "persona": { "system_prompt": "You cook.", "compressed_prompt": "Cook." },
            "tools": [
                { "ref": "start_timer" },
                { "ref": "list_manage", "config": { "list_id": "ingredients" }, "writes_state": ["ingredients"] }
            ],
            "shared_state": [
                { "slot": "ingredients", "access": "read_write", "schema": "list<item>" }
            ],
            "resources": { "strings": ["en"] },
            "localization": { "default_locale": "en" },
            "ui": { "panels": [
                { "type": "editable_list", "id": "list", "checkable": true,
                  "binds_state": "ingredients", "binds_tool": "list_manage", "emits": ["item_checked"] },
                { "type": "timer_stack", "id": "timers", "multi": true, "binds_tool": "start_timer" }
            ] }
        });
        let c = validate(&m).expect("shorthand manifest is valid");

        // pricing: price_usd -> canonical minor units.
        assert_eq!(
            c.pricing,
            Pricing { free: false, price: Some(Price { amount_minor: 500, currency: "USD".to_string() }) }
        );

        // filled defaults.
        assert_eq!(c.manifest_version, "1.0");
        assert_eq!(c.status, "published");
        assert_eq!(c.persona.role, "primary_eligible");
        assert_eq!(c.localization.unit_system_default, "auto");
        assert_eq!(c.compatibility.combine_priority, 50);
        assert!(c.compatibility.conflicts_with.is_empty());

        // tools: empty config/state-routing filled.
        let start = &c.tools[0];
        assert_eq!(start.tool_ref, "start_timer");
        assert_eq!(start.config, json!({}));
        assert!(start.reads_state.is_empty() && start.writes_state.is_empty());
        assert!(start.updates_widget.is_none());

        // editable_list: inline `checkable` folded; region/priority/emits defaulted.
        let list = c.ui.panels.iter().find(|p| p.id == "list").unwrap();
        assert_eq!(list.props, json!({ "checkable": true }));
        assert_eq!(list.region, "side");
        assert_eq!(list.priority, 50);
        assert_eq!(list.min_widget_version, "1.0");
        // bare string emit -> {name, to_chat=<editable_list default = false>}.
        assert_eq!(list.emits, vec![Emit { name: "item_checked".to_string(), to_chat: false }]);
        assert_eq!(list.binds_state.as_deref(), Some("ingredients"));

        // timer_stack: inline `multi` folded; omitted emits -> type default set.
        let timers = c.ui.panels.iter().find(|p| p.id == "timers").unwrap();
        assert_eq!(timers.props, json!({ "multi": true }));
        assert_eq!(timers.emits, vec![Emit { name: "timer_finished".to_string(), to_chat: true }]);

        // the whole thing re-serializes as an object (canonical shape).
        assert!(serde_json::to_value(&c).unwrap().is_object());
    }

    #[test]
    fn canonical_props_win_over_inline_duplicate() {
        // Both an explicit props.multi=false and inline multi=true: props wins.
        let m = with(minimal(), |o| {
            o.insert(
                "ui".to_string(),
                json!({ "panels": [
                    { "type": "timer_stack", "id": "t", "props": { "multi": false }, "multi": true }
                ] }),
            );
        });
        let c = validate(&m).expect("valid");
        assert_eq!(c.ui.panels[0].props, json!({ "multi": false }));
    }
}
