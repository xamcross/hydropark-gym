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

use serde_json::Value;

use crate::capacity::{self, CapacityProjection, CapacityStatus};
use crate::manifest::{self, ValidationIssue};
use crate::orchestrator::{self, ComposedTool, MergeError, SkillManifest};
use crate::tool_routing::{self, RoutingTable, ToolDecl};

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

    // 5. tool -> slot routing (P1-05.3), read from each manifest's `tools[]`.
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
}
