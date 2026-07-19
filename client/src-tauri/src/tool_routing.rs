#![allow(dead_code)] // Phase-1 capability/routing core; wired into the loader/turn loop in a later ticket.

//! Capability/permission model & tool->slot routing (P1-05.2, P1-05.3;
//! SPEC §8.5, §9.3).
//!
//! Two independent, purely-declarative concerns a skill manifest carries:
//!
//!  - **Capabilities (§8.5).** A skill declares `capabilities` — the tool
//!    *categories* it uses — which the installer renders as a plain-language
//!    summary ("This skill can: set timers, convert units, manage a list").
//!    The allowed set is a **closed enum**: exactly the first-party tool
//!    categories. There is deliberately **no network / filesystem / system**
//!    capability for v1 skills, so the closed enum *is* the enforcement — a
//!    manifest declaring an out-of-set capability is rejected. The v1 set is
//!    taken verbatim from `contracts/skill-manifest.schema.json` `$defs/capability`
//!    (`["timers", "unit_conversion", "list_management", "calculation",
//!    "date_math"]`).
//!
//!  - **Tool -> slot routing (§9.3).** Each `tools[]` entry declares the slots it
//!    reads/writes and an optional fallback widget. This module resolves that
//!    into a [`RoutingTable`]: per tool a [`Route`] of the shared-state slots it
//!    `reads`/`writes` and the [`RouteTarget`] its *result* falls back to
//!    (a named `updates_widget`, else `chat` by default). Routing is keyed on
//!    **slot name**, so it stays unambiguous even when a tool is shared or
//!    namespaced across skills (§8.3.3).
//!
//! Like `orchestrator.rs`, this module is free of any Tauri / inference coupling
//! so it is pure and unit-testable (serde + std only). It defines its OWN
//! [`ToolDecl`] view of a `tools[]` entry and does not depend on the tool
//! catalog module.

use serde::Deserialize;

// ---------------------------------------------------------------------------
// Capability / permission model (P1-05.2, SPEC §8.5)
// ---------------------------------------------------------------------------

/// A first-party tool CATEGORY a skill may declare (§8.5). This is the **closed
/// v1 allowed set**, mirroring `contracts/skill-manifest.schema.json`
/// `$defs/capability`. It deliberately has **no** `Network` / `File` / `System`
/// variant: no such capability exists for skills in v1, and the absence of a
/// variant is exactly what makes an out-of-set declaration unrepresentable and
/// therefore rejected by [`parse_capabilities`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    /// `timers` — countdown timers (`start_timer`).
    Timers,
    /// `unit_conversion` — US<->Metric quantity conversion (`convert_units`).
    UnitConversion,
    /// `list_management` — add/remove/reorder/check list items (`list_manage`).
    ListManagement,
    /// `calculation` — arithmetic (`calculate`).
    Calculation,
    /// `date_math` — date/time arithmetic (`date_math`).
    DateMath,
}

impl Capability {
    /// The v1 allowed set, in schema order
    /// (`contracts/skill-manifest.schema.json` `$defs/capability`).
    pub const ALL: [Capability; 5] = [
        Capability::Timers,
        Capability::UnitConversion,
        Capability::ListManagement,
        Capability::Calculation,
        Capability::DateMath,
    ];

    /// The canonical manifest token — the exact string the schema enum uses.
    pub fn as_manifest_str(self) -> &'static str {
        match self {
            Capability::Timers => "timers",
            Capability::UnitConversion => "unit_conversion",
            Capability::ListManagement => "list_management",
            Capability::Calculation => "calculation",
            Capability::DateMath => "date_math",
        }
    }

    /// The plain-language phrase surfaced at install (§8.5 / §11, e.g.
    /// "This skill can: set timers, convert units, manage a list").
    pub fn disclosure_phrase(self) -> &'static str {
        match self {
            Capability::Timers => "set timers",
            Capability::UnitConversion => "convert units",
            Capability::ListManagement => "manage a list",
            Capability::Calculation => "do calculations",
            Capability::DateMath => "do date math",
        }
    }

    /// Parse a single manifest token, or `None` when it is outside the closed set.
    pub fn from_manifest_str(s: &str) -> Option<Capability> {
        Capability::ALL.iter().copied().find(|c| c.as_manifest_str() == s)
    }
}

/// Why a declared `capabilities` list cannot be accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityError {
    /// A declared capability is outside the closed v1 set (§8.5). This is how an
    /// attempt to request `network` / `file` / `system` — which have no variant
    /// and no runtime — is rejected. The offending token is named for the message.
    OutOfSet { value: String },
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapabilityError::OutOfSet { value } => write!(
                f,
                "capability '{value}' is not in the v1 allowed set ({}); \
                 skills have no network/file/system capabilities in v1",
                allowed_manifest_list()
            ),
        }
    }
}

impl std::error::Error for CapabilityError {}

/// The allowed manifest tokens as a comma-joined string, for error messages.
fn allowed_manifest_list() -> String {
    Capability::ALL.iter().map(|c| c.as_manifest_str()).collect::<Vec<_>>().join(", ")
}

/// Parse a manifest `capabilities` array into the closed enum, in declared order.
///
/// Any token outside the v1 set (e.g. `"network"`, `"file"`, `"system"`) fails
/// with [`CapabilityError::OutOfSet`] naming it — the closed enum *is* the
/// permission gate (§8.5). The first out-of-set token short-circuits.
pub fn parse_capabilities(declared: &[String]) -> Result<Vec<Capability>, CapabilityError> {
    declared
        .iter()
        .map(|s| {
            Capability::from_manifest_str(s)
                .ok_or_else(|| CapabilityError::OutOfSet { value: s.clone() })
        })
        .collect()
}

/// Render the install-time disclosure line (§8.5 / §11): a plain-language
/// summary of what the skill can do, built from its declared capabilities.
///
/// e.g. `[Timers, UnitConversion, ListManagement]` ->
/// `"This skill can: set timers, convert units, manage a list"`.
pub fn disclose(caps: &[Capability]) -> String {
    if caps.is_empty() {
        return "This skill uses no special capabilities.".to_string();
    }
    let phrases: Vec<&str> = caps.iter().map(|c| c.disclosure_phrase()).collect();
    format!("This skill can: {}", phrases.join(", "))
}

// ---------------------------------------------------------------------------
// Tool -> slot routing (P1-05.3, SPEC §9.3)
// ---------------------------------------------------------------------------

/// A shared-state slot name (§8.3.4). The routing key that ties tools to widgets.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Slot(pub String);

impl Slot {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for Slot {
    fn from(s: &str) -> Self {
        Slot(s.to_string())
    }
}

impl From<String> for Slot {
    fn from(s: String) -> Self {
        Slot(s)
    }
}

impl std::fmt::Display for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// This module's own view of a manifest `tools[]` entry (§9.3), deserialized
/// straight from the manifest. Independent of the tool-catalog module: only the
/// routing-relevant fields are modelled; `config` and any other keys are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolDecl {
    /// The first-party tool reference (schema `$defs/toolRef`), or a namespaced
    /// call-name (`<skill_id>.<ref>`) once composed (§8.3.3). Opaque here.
    #[serde(rename = "ref")]
    pub tool_ref: String,
    /// Slots this tool reads as input (§9.3).
    #[serde(default)]
    pub reads_state: Vec<String>,
    /// Slots this tool writes; every widget with `binds_state` on such a slot
    /// re-renders on write (§9.3).
    #[serde(default)]
    pub writes_state: Vec<String>,
    /// Fallback routing target for a result that declares no `writes_state`
    /// (§9.3); absent -> chat.
    #[serde(default)]
    pub updates_widget: Option<String>,
}

/// Where a tool's *result* is delivered when it writes no state (§9.3).
///
/// Note (§9.3): `writes_state` is the *primary* routing — a tool that writes
/// slots delivers its result to every widget bound to those slots (see
/// [`Route::writes`]). `RouteTarget` is the fallback sink for the result itself:
/// a named widget if the tool declares `updates_widget`, else the chat transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteTarget {
    /// Deliver the result to the named `updates_widget` (§9.3).
    Widget(String),
    /// Default: post the result as a line in the chat transcript (§9.3).
    Chat,
}

/// The resolved routing for one tool (§9.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    /// Slots read as input.
    pub reads: Vec<Slot>,
    /// Slots written; bound widgets re-render on write.
    pub writes: Vec<Slot>,
    /// Fallback result sink: `Widget(name)` when `updates_widget` is set, else `Chat`.
    pub target: RouteTarget,
}

/// The routing table for an agent's composed tool set: one [`Route`] per tool,
/// in input order, keyed by the tool's `ref` (which may be a namespaced
/// call-name, §8.3.3).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoutingTable {
    pub routes: Vec<(String, Route)>,
}

impl RoutingTable {
    /// The route for a given tool ref, if present (first match on duplicate refs).
    pub fn get(&self, tool_ref: &str) -> Option<&Route> {
        self.routes.iter().find(|(r, _)| r == tool_ref).map(|(_, route)| route)
    }

    pub fn len(&self) -> usize {
        self.routes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }
}

/// Build the [`RoutingTable`] from a slice of tool declarations (§9.3).
///
/// For each tool: `reads`/`writes` mirror `reads_state`/`writes_state`; the
/// result `target` is `Widget(name)` when `updates_widget` is set, else `Chat`.
pub fn route_tools(tools: &[ToolDecl]) -> RoutingTable {
    let routes = tools
        .iter()
        .map(|t| {
            let reads = t.reads_state.iter().cloned().map(Slot).collect();
            let writes = t.writes_state.iter().cloned().map(Slot).collect();
            let target = match &t.updates_widget {
                Some(w) => RouteTarget::Widget(w.clone()),
                None => RouteTarget::Chat,
            };
            (t.tool_ref.clone(), Route { reads, writes, target })
        })
        .collect();
    RoutingTable { routes }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn td(v: serde_json::Value) -> ToolDecl {
        serde_json::from_value(v).expect("valid test tool decl")
    }

    fn slots(names: &[&str]) -> Vec<Slot> {
        names.iter().map(|n| Slot(n.to_string())).collect()
    }

    // -- capabilities -------------------------------------------------------

    #[test]
    fn allowed_capabilities_parse_to_the_enum_in_order() {
        let declared: Vec<String> = ["timers", "unit_conversion", "list_management", "calculation", "date_math"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let caps = parse_capabilities(&declared).expect("all in-set");
        assert_eq!(
            caps,
            vec![
                Capability::Timers,
                Capability::UnitConversion,
                Capability::ListManagement,
                Capability::Calculation,
                Capability::DateMath,
            ]
        );
        // and the whole closed set round-trips through its manifest token
        for c in Capability::ALL {
            assert_eq!(Capability::from_manifest_str(c.as_manifest_str()), Some(c));
        }
    }

    #[test]
    fn out_of_set_network_capability_is_rejected_naming_it() {
        let err = parse_capabilities(&["network".to_string()]).unwrap_err();
        assert_eq!(err, CapabilityError::OutOfSet { value: "network".to_string() });
        // the message names the offending token and flags the v1 no-network rule
        let msg = err.to_string();
        assert!(msg.contains("network"), "message must name the token: {msg}");
        assert!(msg.contains("v1"), "message must reference the v1 rule: {msg}");
    }

    #[test]
    fn out_of_set_file_capability_is_rejected_even_after_valid_ones() {
        let declared = vec!["timers".to_string(), "file".to_string()];
        let err = parse_capabilities(&declared).unwrap_err();
        assert_eq!(err, CapabilityError::OutOfSet { value: "file".to_string() });
    }

    #[test]
    fn system_capability_has_no_variant_and_is_rejected() {
        assert_eq!(Capability::from_manifest_str("system"), None);
        assert!(parse_capabilities(&["system".to_string()]).is_err());
    }

    #[test]
    fn disclosure_renders_plain_language_summary() {
        let caps = [Capability::Timers, Capability::UnitConversion, Capability::ListManagement];
        assert_eq!(disclose(&caps), "This skill can: set timers, convert units, manage a list");
    }

    #[test]
    fn disclosure_covers_calculation_and_date_math() {
        let caps = [Capability::Calculation, Capability::DateMath];
        assert_eq!(disclose(&caps), "This skill can: do calculations, do date math");
    }

    #[test]
    fn disclosure_of_no_capabilities_is_graceful() {
        assert_eq!(disclose(&[]), "This skill uses no special capabilities.");
    }

    // -- tool -> slot routing ----------------------------------------------

    #[test]
    fn writes_state_populates_writes_and_defaults_target_to_chat() {
        let t = td(json!({ "ref": "list_manage", "writes_state": ["ingredients"] }));
        let table = route_tools(std::slice::from_ref(&t));
        let route = table.get("list_manage").expect("routed");
        assert_eq!(route.writes, slots(&["ingredients"]));
        assert!(route.reads.is_empty());
        assert_eq!(route.target, RouteTarget::Chat);
    }

    #[test]
    fn updates_widget_sets_the_widget_target() {
        let t = td(json!({ "ref": "convert_units", "updates_widget": "converter" }));
        let table = route_tools(std::slice::from_ref(&t));
        let route = table.get("convert_units").expect("routed");
        assert_eq!(route.target, RouteTarget::Widget("converter".to_string()));
        assert!(route.writes.is_empty());
    }

    #[test]
    fn neither_writes_nor_widget_routes_to_chat_by_default() {
        let t = td(json!({ "ref": "calculate" }));
        let table = route_tools(std::slice::from_ref(&t));
        let route = table.get("calculate").expect("routed");
        assert_eq!(route.target, RouteTarget::Chat);
        assert!(route.reads.is_empty());
        assert!(route.writes.is_empty());
    }

    #[test]
    fn reads_state_populates_reads() {
        let t = td(json!({ "ref": "calculate", "reads_state": ["servings", "portions"] }));
        let table = route_tools(std::slice::from_ref(&t));
        let route = table.get("calculate").expect("routed");
        assert_eq!(route.reads, slots(&["servings", "portions"]));
    }

    #[test]
    fn writes_and_updates_widget_coexist() {
        // §9.3: writes drive slot re-renders; the widget target is the result sink.
        let t = td(json!({
            "ref": "list_manage",
            "reads_state": ["pantry"],
            "writes_state": ["ingredients"],
            "updates_widget": "shopping_list"
        }));
        let table = route_tools(std::slice::from_ref(&t));
        let route = table.get("list_manage").expect("routed");
        assert_eq!(route.reads, slots(&["pantry"]));
        assert_eq!(route.writes, slots(&["ingredients"]));
        assert_eq!(route.target, RouteTarget::Widget("shopping_list".to_string()));
    }

    #[test]
    fn route_tools_preserves_every_tool_in_order() {
        let tools = vec![
            td(json!({ "ref": "start_timer", "updates_widget": "timers" })),
            td(json!({ "ref": "convert_units" })),
            td(json!({ "ref": "list_manage", "writes_state": ["ingredients"] })),
        ];
        let table = route_tools(&tools);
        assert_eq!(table.len(), 3);
        let refs: Vec<&str> = table.routes.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(refs, vec!["start_timer", "convert_units", "list_manage"]);
        assert_eq!(table.get("missing_tool"), None);
    }

    #[test]
    fn tool_decl_ignores_config_and_unknown_fields() {
        // `config` (and anything else) is not routing-relevant and must be ignored.
        let t = td(json!({
            "ref": "convert_units",
            "config": { "domains": ["mass", "volume"] },
            "reads_state": ["unit_system"]
        }));
        assert_eq!(t.tool_ref, "convert_units");
        assert_eq!(t.reads_state, vec!["unit_system".to_string()]);
    }
}
