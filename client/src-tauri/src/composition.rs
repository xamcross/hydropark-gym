#![allow(dead_code)] // wired into the `compose_agent` Tauri command in the next integration step.

//! Agent composition pipeline (integration point, SPEC §8.3). This is the one
//! place that chains the individually-built modules into a single live flow when
//! the set of *enabled* skills changes:
//!
//!   1. validate each skill's manifest client-side, offline (`manifest`, P1-03.1);
//!   2. merge them into one agent — order / persona / tools / conflicts
//!      (`orchestrator`, P1-04.1-.3/.9);
//!   3. gate on the context-capacity budget, blocking on overflow
//!      (`capacity`, P1-04.7);
//!   4. resolve tool -> slot routing (`tool_routing`, P1-05.3).
//!
//! Pure logic (no Tauri coupling) so it is unit-testable under the mock feature;
//! the `compose_agent` Tauri command is a thin wrapper over [`compose_agent`].

use serde::Serialize;
use serde_json::Value;

use crate::capacity::{self, CapacityProjection, CapacityStatus};
use crate::manifest::{self, ValidationIssue};
use crate::orchestrator::{self, ComposedTool, MergeError, SkillManifest};
use crate::tool_routing::{self, RouteTarget, RoutingTable, ToolDecl};

/// The fully composed agent produced from the set of enabled skills.
#[derive(Debug)]
pub struct ComposedAgent {
    /// Skills in deterministic merge order (primary first).
    pub order: Vec<String>,
    /// The primary (leading) skill, or `None` when the base agent leads.
    pub primary: Option<String>,
    /// The assembled system prompt (base + primary + compressed secondaries).
    pub persona: String,
    /// The composed, collision-resolved tool set.
    pub tools: Vec<ComposedTool>,
    /// Per-tool state/widget/chat routing.
    pub routing: RoutingTable,
    /// The context-capacity projection (already checked to be within budget).
    pub capacity: CapacityProjection,
}

/// Why a set of enabled skills could not be composed into an agent.
#[derive(Debug)]
pub enum CompositionError {
    /// A skill's manifest failed client-side validation before it could compose.
    InvalidManifest { skill_id: String, issues: Vec<ValidationIssue> },
    /// A manifest could not be parsed into the composition view.
    Malformed { index: usize, reason: String },
    /// Two enabled skills declare each other incompatible (`conflicts_with`).
    Conflict { a: String, b: String },
    /// The composed context would overflow the model window (block, §8.3.5).
    CapacityOverflow { projection: CapacityProjection },
}

impl std::fmt::Display for CompositionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompositionError::InvalidManifest { skill_id, issues } => {
                write!(f, "skill '{skill_id}' failed validation ({} issue(s))", issues.len())
            }
            CompositionError::Malformed { index, reason } => {
                write!(f, "manifest #{index} is malformed: {reason}")
            }
            CompositionError::Conflict { a, b } => {
                write!(f, "skills '{a}' and '{b}' declare each other incompatible")
            }
            CompositionError::CapacityOverflow { projection } => write!(
                f,
                "composed context ({} tokens) overflows the {}-token window",
                projection.used_tokens, projection.ctx_window
            ),
        }
    }
}

impl std::error::Error for CompositionError {}

/// Compose the enabled skills' manifests into a single agent, or explain why not.
///
/// `manifests` are the raw `.hpskill` manifest JSON values for the currently
/// enabled skills. `primary_hint` (optional) is the user's chosen lead skill;
/// `n_ctx` is the model context window (e.g. 4096).
pub fn compose_agent(
    base_preamble: &str,
    manifests: &[Value],
    primary_hint: Option<&str>,
    n_ctx: u32,
) -> Result<ComposedAgent, CompositionError> {
    // 1. Offline validation (P1-03.1) — a skill that fails validation is never composed.
    for m in manifests {
        if let Err(issues) = manifest::validate(m) {
            let skill_id =
                m.get("id").and_then(Value::as_str).unwrap_or("<unknown>").to_string();
            return Err(CompositionError::InvalidManifest { skill_id, issues });
        }
    }

    // 2. Parse into the orchestrator's merge view (a subset of the manifest).
    let mut skills: Vec<SkillManifest> = Vec::with_capacity(manifests.len());
    for (index, m) in manifests.iter().enumerate() {
        let sm = serde_json::from_value::<SkillManifest>(m.clone())
            .map_err(|e| CompositionError::Malformed { index, reason: e.to_string() })?;
        skills.push(sm);
    }

    // 3. Merge (P1-04.1/.2/.3/.9): order, persona, tool union/collision, conflicts.
    let merged = orchestrator::merge(base_preamble, &skills, primary_hint).map_err(|e| match e {
        MergeError::Conflict { a, b } => CompositionError::Conflict { a, b },
    })?;

    // 4. Capacity gate (P1-04.7): block before enabling if the projection overflows.
    let projection = capacity::project(&skills, n_ctx);
    if matches!(projection.status, CapacityStatus::Blocked { .. }) {
        return Err(CompositionError::CapacityOverflow { projection });
    }

    // 5. tool -> slot routing (P1-05.3), read from each manifest's `tools[]`. NOTE: one route per
    //    declaration (skills that share a tool each contribute a route); aligning routing to the
    //    composed/namespaced call-names (§8.3.3) so it is keyed by `ComposedTool.call_name` is a
    //    follow-up.
    let tool_decls: Vec<ToolDecl> = manifests
        .iter()
        .filter_map(|m| m.get("tools").and_then(Value::as_array))
        .flatten()
        .filter_map(|t| serde_json::from_value::<ToolDecl>(t.clone()).ok())
        .collect();
    let routing = tool_routing::route_tools(&tool_decls);

    Ok(ComposedAgent {
        order: merged.order,
        primary: merged.primary,
        persona: merged.persona,
        tools: merged.tools,
        routing,
        capacity: projection,
    })
}

// ---------------------------------------------------------------------------
// Serializable wire view — the shape the `compose_agent` Tauri command returns.
// `ComposedAgent` holds cross-module types that aren't `Serialize`, so this
// flattens it to a stable snake_case wire object the Angular UI consumes.
// ---------------------------------------------------------------------------

/// The base agent's voice — the preamble every composed persona opens with, and
/// the leading voice when no `primary_eligible` skill leads (§8.3.1).
pub const BASE_PREAMBLE: &str =
    "You are Hydropark, a private assistant that runs fully on-device. You are offline and never \
     send the conversation anywhere. Be helpful, concise, and honest.";

#[derive(Debug, Serialize)]
pub struct ComposedAgentView {
    pub order: Vec<String>,
    pub primary: Option<String>,
    pub persona: String,
    pub tools: Vec<ToolView>,
    pub routing: Vec<RouteView>,
    pub capacity: CapacityView,
}

#[derive(Debug, Serialize)]
pub struct ToolView {
    pub call_name: String,
    pub tool_ref: String,
    pub contributors: Vec<String>,
    pub namespaced: bool,
}

#[derive(Debug, Serialize)]
pub struct RouteView {
    pub tool_ref: String,
    pub reads: Vec<String>,
    pub writes: Vec<String>,
    /// `"chat"` or `"widget:<name>"`.
    pub target: String,
}

#[derive(Debug, Serialize)]
pub struct CapacityView {
    pub ctx_window: u32,
    pub reserve_tokens: u32,
    pub skill_tokens: u32,
    pub used_tokens: u32,
    pub remaining: u32,
    pub blocked: bool,
    pub overflow: u32,
}

/// A structured composition failure the command returns to the UI.
#[derive(Debug, Serialize)]
pub struct ComposeErrorView {
    /// Machine code: `invalid_manifest` | `malformed` | `conflict` | `capacity_overflow`.
    pub kind: String,
    pub message: String,
}

impl ComposedAgent {
    pub fn to_view(&self) -> ComposedAgentView {
        ComposedAgentView {
            order: self.order.clone(),
            primary: self.primary.clone(),
            persona: self.persona.clone(),
            tools: self
                .tools
                .iter()
                .map(|t| ToolView {
                    call_name: t.call_name.clone(),
                    tool_ref: t.tool_ref.clone(),
                    contributors: t.contributors.clone(),
                    namespaced: t.namespaced,
                })
                .collect(),
            routing: self
                .routing
                .routes
                .iter()
                .map(|(tref, route)| RouteView {
                    tool_ref: tref.clone(),
                    reads: route.reads.iter().map(|s| s.to_string()).collect(),
                    writes: route.writes.iter().map(|s| s.to_string()).collect(),
                    target: match &route.target {
                        RouteTarget::Widget(w) => format!("widget:{w}"),
                        RouteTarget::Chat => "chat".to_string(),
                    },
                })
                .collect(),
            capacity: CapacityView {
                ctx_window: self.capacity.ctx_window,
                reserve_tokens: self.capacity.reserve_tokens,
                skill_tokens: self.capacity.skill_tokens,
                used_tokens: self.capacity.used_tokens,
                remaining: self.capacity.remaining,
                blocked: matches!(self.capacity.status, CapacityStatus::Blocked { .. }),
                overflow: match self.capacity.status {
                    CapacityStatus::Blocked { overflow } => overflow,
                    CapacityStatus::Ok => 0,
                },
            },
        }
    }
}

impl From<CompositionError> for ComposeErrorView {
    fn from(e: CompositionError) -> Self {
        let kind = match &e {
            CompositionError::InvalidManifest { .. } => "invalid_manifest",
            CompositionError::Malformed { .. } => "malformed",
            CompositionError::Conflict { .. } => "conflict",
            CompositionError::CapacityOverflow { .. } => "capacity_overflow",
        };
        ComposeErrorView { kind: kind.to_string(), message: e.to_string() }
    }
}

/// Command-friendly wrapper: compose the enabled manifests into the wire view or
/// a structured error, using [`BASE_PREAMBLE`] as the base voice.
pub fn compose_agent_view(
    manifests: &[Value],
    primary_hint: Option<&str>,
    n_ctx: u32,
) -> Result<ComposedAgentView, ComposeErrorView> {
    compose_agent(BASE_PREAMBLE, manifests, primary_hint, n_ctx)
        .map(|a| a.to_view())
        .map_err(ComposeErrorView::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example(json: &str) -> Value {
        serde_json::from_str(json).expect("valid example manifest")
    }

    fn kitchen_timer() -> Value {
        example(include_str!("../../../contracts/examples/kitchen-timer.manifest.json"))
    }

    fn cooking_assistant() -> Value {
        example(include_str!("../../../contracts/examples/cooking-assistant.manifest.json"))
    }

    #[test]
    fn composes_the_two_reference_skills_end_to_end() {
        let composed =
            compose_agent("BASE PREAMBLE", &[kitchen_timer(), cooking_assistant()], None, 4096)
                .expect("both reference skills compose");

        // cooking-assistant (combine_priority 60) leads over kitchen-timer (40).
        assert_eq!(composed.primary.as_deref(), Some("cooking-assistant"));
        assert_eq!(composed.order, vec!["cooking-assistant", "kitchen-timer"]);

        // Persona = base + primary's full prompt + the secondary's compressed form.
        assert!(composed.persona.starts_with("BASE PREAMBLE"));
        assert!(composed.persona.contains("Cooking Assistant"));

        // Both skills declare the same 3 first-party tools with equal config -> shared, not namespaced.
        assert_eq!(composed.tools.len(), 3);
        assert!(composed.tools.iter().all(|t| !t.namespaced));

        // Small personas fit the 4096 window.
        assert!(matches!(composed.capacity.status, CapacityStatus::Ok));
        assert!(composed.capacity.used_tokens <= composed.capacity.ctx_window);
    }

    #[test]
    fn a_single_skill_composes_as_its_own_primary() {
        let composed = compose_agent("BASE", &[cooking_assistant()], None, 4096).unwrap();
        assert_eq!(composed.primary.as_deref(), Some("cooking-assistant"));
        assert_eq!(composed.order, vec!["cooking-assistant"]);
    }

    #[test]
    fn an_invalid_manifest_is_rejected_before_composing() {
        let mut bad = kitchen_timer();
        bad.as_object_mut().unwrap().remove("id"); // required field
        let err = compose_agent("BASE", &[bad], None, 4096).unwrap_err();
        assert!(matches!(err, CompositionError::InvalidManifest { .. }));
    }

    #[test]
    fn a_tiny_context_window_overflows_and_blocks() {
        // 8 tokens cannot hold the reserve + either persona.
        let err = compose_agent("BASE", &[cooking_assistant()], None, 8).unwrap_err();
        assert!(matches!(err, CompositionError::CapacityOverflow { .. }));
    }

    #[test]
    fn view_flattens_and_serializes_for_the_command() {
        let view = compose_agent_view(&[kitchen_timer(), cooking_assistant()], None, 4096).unwrap();
        assert_eq!(view.primary.as_deref(), Some("cooking-assistant"));
        assert_eq!(view.tools.len(), 3);
        assert!(!view.capacity.blocked);
        // Routing has one entry per skill tool DECLARATION (6 = 2 skills x 3 tools); aligning it to
        // the composed/namespaced call-names (§8.3.3) is the documented follow-up in compose_agent.
        assert_eq!(view.routing.len(), 6);
        let json = serde_json::to_string(&view).expect("view serializes");
        assert!(json.contains("cooking-assistant"));
        // IP: the composed persona is the assembled prompt (intended), but no raw
        // manifest system_prompt key leaks into the wire object.
        assert!(!json.contains("\"system_prompt\""));

        let err = compose_agent_view(&[cooking_assistant()], None, 8).unwrap_err();
        assert_eq!(err.kind, "capacity_overflow");
    }
}
