#![allow(dead_code)] // Phase-1 composition core; wired into the turn loop in a later ticket.

//! Skill composition & merge (P1-04.1/.2/.3/.9, SPEC §8.3.1-8.3.3, §8.3.6).
//!
//! Given the set of *enabled* skills for an agent, this produces the composed
//! agent deterministically:
//!
//!  - **Order** (§8.3.1-8.3.2): the primary voice first, then every other skill
//!    by `combine_priority` **descending**, ties broken by `id` **ascending**.
//!  - **Primary / persona** (§8.3.1): the base preamble, then the primary skill's
//!    *full* `system_prompt`, then each secondary's *compressed* prompt. When no
//!    enabled skill is `primary_eligible`, the base agent leads (base-as-primary
//!    fallback) and every skill is a compressed secondary.
//!  - **Tools** (§8.3.3): the union of every skill's tools, with collisions
//!    resolved — the same tool `ref` with the same config is a **shared instance**;
//!    the same `ref` with differing config becomes **namespaced variants**
//!    (`<skill_id>.<ref>`).
//!  - **Conflicts** (§8.3.6): if any two enabled skills declare each other in
//!    `conflicts_with`, the combination is blocked.
//!
//! This module is intentionally free of any Tauri / inference coupling so it is
//! pure and unit-testable (`cargo test --no-default-features --features
//! mock-inference`). Shared-state/slots (§8.3.4-5) and the capacity meter
//! (§8.3.5) are separate tickets (P1-04.4-.8) and are not modelled here.

use std::collections::BTreeMap;
use std::collections::HashMap;

use serde::Deserialize;

/// The subset of a skill manifest the orchestrator needs to compose an agent.
/// Deserializes from the canonical manifest (contracts/skill-manifest.schema.json);
/// fields the merge does not use are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct SkillManifest {
    pub id: String,
    #[serde(default)]
    pub persona: Persona,
    #[serde(default)]
    pub tools: Vec<ToolRef>,
    #[serde(default)]
    pub compatibility: Compatibility,
    /// Slots this skill reads/writes in the shared-state store (SPEC §8.3.4).
    /// Interpreted by the `shared_state` module.
    #[serde(default)]
    pub shared_state: Vec<SharedStateDecl>,
    /// The certified/self-declared cost projection the capacity meter trusts (§8.3.5).
    #[serde(default)]
    pub cost_estimate: CostEstimate,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Persona {
    #[serde(default)]
    pub role: Role,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub compressed_prompt: String,
}

/// Whether a skill may lead as the primary voice (SPEC §8.3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    #[default]
    PrimaryEligible,
    SecondaryOnly,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolRef {
    #[serde(rename = "ref")]
    pub tool_ref: String,
    /// Opaque per-skill tool config; `Null` when absent. Two skills that declare
    /// the same `ref` with an *equal* config share one instance; differing config
    /// forces namespaced variants.
    #[serde(default)]
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Compatibility {
    #[serde(default = "default_combine_priority")]
    pub combine_priority: i64,
    #[serde(default)]
    pub conflicts_with: Vec<String>,
}

fn default_combine_priority() -> i64 {
    50
}

impl Default for Compatibility {
    fn default() -> Self {
        Self { combine_priority: default_combine_priority(), conflicts_with: Vec::new() }
    }
}

/// A shared-state slot a skill declares (SPEC §8.3.4). `schema` is the closed type
/// language ("scalar" | "list<item>" | "record"); the `shared_state` module
/// interprets it. `access` is "read" | "write" | "read_write".
#[derive(Debug, Clone, Deserialize)]
pub struct SharedStateDecl {
    pub slot: String,
    #[serde(default)]
    pub access: String,
    #[serde(default)]
    pub schema: String,
}

/// The certified (or interim self-declared) cost projection the capacity meter
/// trusts (SPEC §8.3.5; the certified figure comes from P1-20.2).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CostEstimate {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub tools: u32,
    #[serde(default)]
    pub panels: u32,
}

/// The composed agent produced by [`merge`].
#[derive(Debug, Clone, PartialEq)]
pub struct MergedAgent {
    /// Skill ids in deterministic merge order: primary first (if any), then
    /// `combine_priority` desc, `id` asc.
    pub order: Vec<String>,
    /// The primary skill id, or `None` when the base agent leads.
    pub primary: Option<String>,
    /// The assembled system prompt (base + primary full + compressed secondaries).
    pub persona: String,
    /// The composed tool set with collisions resolved, sorted by `call_name`.
    pub tools: Vec<ComposedTool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComposedTool {
    /// The name the model calls; namespaced (`<skill_id>.<ref>`) on a config collision.
    pub call_name: String,
    /// The underlying first-party tool ref.
    pub tool_ref: String,
    /// The skill ids that contributed this tool, in merge order.
    pub contributors: Vec<String>,
    /// True when this is a namespaced variant produced by a config collision.
    pub namespaced: bool,
}

/// Why a set of enabled skills cannot be composed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeError {
    /// Two enabled skills declare each other incompatible (`conflicts_with`, §8.3.6).
    /// Ids are reported `id`-ascending for a stable message.
    Conflict { a: String, b: String },
}

impl std::fmt::Display for MergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergeError::Conflict { a, b } => {
                write!(f, "skills '{a}' and '{b}' declare each other incompatible (conflicts_with)")
            }
        }
    }
}

impl std::error::Error for MergeError {}

/// Compose the enabled skills into a single agent.
///
/// `primary_hint` (e.g. the user's chosen lead skill) wins if it names an enabled
/// `primary_eligible` skill; otherwise the highest-`combine_priority`
/// `primary_eligible` skill leads (ties: `id` ascending). With no eligible skill,
/// `primary` is `None` and the base preamble is the leading voice.
pub fn merge(
    base_preamble: &str,
    enabled: &[SkillManifest],
    primary_hint: Option<&str>,
) -> Result<MergedAgent, MergeError> {
    // 1. conflicts_with (P1-04.9, §8.3.6): symmetric — either declaration blocks.
    for (i, a) in enabled.iter().enumerate() {
        for b in enabled.iter().skip(i + 1) {
            let a_blocks = a.compatibility.conflicts_with.iter().any(|c| c == &b.id);
            let b_blocks = b.compatibility.conflicts_with.iter().any(|c| c == &a.id);
            if a_blocks || b_blocks {
                let (x, y) =
                    if a.id <= b.id { (a.id.clone(), b.id.clone()) } else { (b.id.clone(), a.id.clone()) };
                return Err(MergeError::Conflict { a: x, b: y });
            }
        }
    }

    // 2. primary (P1-04.1/.2).
    let primary_id = choose_primary(enabled, primary_hint);

    // Secondaries = everything except the primary, ordered priority desc / id asc.
    let mut secondaries: Vec<&SkillManifest> =
        enabled.iter().filter(|s| Some(&s.id) != primary_id.as_ref()).collect();
    secondaries.sort_by(|a, b| {
        b.compatibility
            .combine_priority
            .cmp(&a.compatibility.combine_priority)
            .then_with(|| a.id.cmp(&b.id))
    });

    let primary = primary_id.as_ref().and_then(|pid| enabled.iter().find(|s| &s.id == pid));

    let mut order: Vec<String> = Vec::new();
    if let Some(p) = primary {
        order.push(p.id.clone());
    }
    order.extend(secondaries.iter().map(|s| s.id.clone()));

    // 3. persona (P1-04.2).
    let persona = assemble_persona(base_preamble, primary, &secondaries);

    // 4. tools (P1-04.3).
    let tools = compose_tools(enabled, &order);

    Ok(MergedAgent { order, primary: primary_id, persona, tools })
}

fn choose_primary(enabled: &[SkillManifest], hint: Option<&str>) -> Option<String> {
    if let Some(h) = hint {
        if let Some(s) = enabled.iter().find(|s| s.id == h) {
            if s.persona.role == Role::PrimaryEligible {
                return Some(s.id.clone());
            }
        }
    }
    enabled
        .iter()
        .filter(|s| s.persona.role == Role::PrimaryEligible)
        // Greatest priority wins; on a tie the *smaller* id wins (id asc), so it
        // must compare as "greater" for `max_by`.
        .max_by(|a, b| {
            a.compatibility
                .combine_priority
                .cmp(&b.compatibility.combine_priority)
                .then_with(|| b.id.cmp(&a.id))
        })
        .map(|s| s.id.clone())
}

fn assemble_persona(
    base: &str,
    primary: Option<&SkillManifest>,
    secondaries: &[&SkillManifest],
) -> String {
    let mut parts: Vec<String> = Vec::new();
    let base = base.trim();
    if !base.is_empty() {
        parts.push(base.to_string());
    }
    if let Some(p) = primary {
        let sp = p.persona.system_prompt.trim();
        if !sp.is_empty() {
            parts.push(sp.to_string());
        }
    }
    for s in secondaries {
        let compressed = s.persona.compressed_prompt.trim();
        if !compressed.is_empty() {
            parts.push(format!("Also available - {}: {}", s.id, compressed));
        }
    }
    parts.join("\n\n")
}

fn compose_tools(enabled: &[SkillManifest], order: &[String]) -> Vec<ComposedTool> {
    let by_id: HashMap<&str, &SkillManifest> =
        enabled.iter().map(|s| (s.id.as_str(), s)).collect();

    // ref -> [(skill_id, config)] gathered in merge order.
    let mut groups: BTreeMap<String, Vec<(String, serde_json::Value)>> = BTreeMap::new();
    for sid in order {
        if let Some(s) = by_id.get(sid.as_str()) {
            for t in &s.tools {
                groups
                    .entry(t.tool_ref.clone())
                    .or_default()
                    .push((s.id.clone(), t.config.clone()));
            }
        }
    }

    let mut out: Vec<ComposedTool> = Vec::new();
    for (tref, contributors) in groups {
        let mut distinct: Vec<&serde_json::Value> = Vec::new();
        for (_, cfg) in &contributors {
            if !distinct.iter().any(|c| *c == cfg) {
                distinct.push(cfg);
            }
        }
        if distinct.len() <= 1 {
            out.push(ComposedTool {
                call_name: tref.clone(),
                tool_ref: tref.clone(),
                contributors: contributors.iter().map(|(id, _)| id.clone()).collect(),
                namespaced: false,
            });
        } else {
            for (sid, _) in &contributors {
                out.push(ComposedTool {
                    call_name: format!("{sid}.{tref}"),
                    tool_ref: tref.clone(),
                    contributors: vec![sid.clone()],
                    namespaced: true,
                });
            }
        }
    }
    out.sort_by(|a, b| a.call_name.cmp(&b.call_name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(v: serde_json::Value) -> SkillManifest {
        serde_json::from_value(v).expect("valid test manifest")
    }

    #[test]
    fn orders_primary_first_then_priority_desc_then_id_asc() {
        let a = m(json!({"id":"aaa","persona":{"role":"primary_eligible"},"compatibility":{"combine_priority":40}}));
        let b = m(json!({"id":"bbb","persona":{"role":"primary_eligible"},"compatibility":{"combine_priority":60}}));
        let c = m(json!({"id":"ccc","persona":{"role":"secondary_only"},"compatibility":{"combine_priority":60}}));
        let merged = merge("BASE", &[a, b, c], None).unwrap();
        assert_eq!(merged.primary, Some("bbb".to_string()));
        // bbb leads; then priority desc / id asc over the rest: ccc(60), aaa(40).
        assert_eq!(merged.order, vec!["bbb", "ccc", "aaa"]);
    }

    #[test]
    fn id_ascending_breaks_priority_ties_for_primary() {
        let a = m(json!({"id":"zeta","persona":{"role":"primary_eligible"},"compatibility":{"combine_priority":50}}));
        let b = m(json!({"id":"alpha","persona":{"role":"primary_eligible"},"compatibility":{"combine_priority":50}}));
        let merged = merge("BASE", &[a, b], None).unwrap();
        assert_eq!(merged.primary, Some("alpha".to_string())); // tie -> id asc
        assert_eq!(merged.order, vec!["alpha", "zeta"]);
    }

    #[test]
    fn base_as_primary_fallback_when_no_eligible_skill() {
        let a = m(json!({"id":"aaa","persona":{"role":"secondary_only","compressed_prompt":"timers"},"compatibility":{"combine_priority":30}}));
        let b = m(json!({"id":"bbb","persona":{"role":"secondary_only","compressed_prompt":"units"},"compatibility":{"combine_priority":70}}));
        let merged = merge("BASE PREAMBLE", &[a, b], None).unwrap();
        assert_eq!(merged.primary, None);
        assert_eq!(merged.order, vec!["bbb", "aaa"]); // priority desc
        assert!(merged.persona.starts_with("BASE PREAMBLE"));
        // both are compressed secondaries, in order
        let ib = merged.persona.find("units").unwrap();
        let ia = merged.persona.find("timers").unwrap();
        assert!(ib < ia, "secondaries appear in merge order");
    }

    #[test]
    fn persona_is_base_then_primary_full_then_compressed_secondaries() {
        let primary = m(json!({"id":"cooking","persona":{"role":"primary_eligible","system_prompt":"FULL COOKING PROMPT","compressed_prompt":"cook"},"compatibility":{"combine_priority":60}}));
        let secondary = m(json!({"id":"packing","persona":{"role":"secondary_only","compressed_prompt":"PACKING SUMMARY"},"compatibility":{"combine_priority":40}}));
        let merged = merge("BASE", &[primary, secondary], None).unwrap();
        let ibase = merged.persona.find("BASE").unwrap();
        let ifull = merged.persona.find("FULL COOKING PROMPT").unwrap();
        let icomp = merged.persona.find("PACKING SUMMARY").unwrap();
        assert!(ibase < ifull && ifull < icomp, "base -> primary full -> compressed secondary");
        // the primary's *compressed* form must NOT be used when it leads
        assert!(!merged.persona.contains("Also available - cooking"));
    }

    #[test]
    fn primary_hint_overrides_auto_selection() {
        let hi = m(json!({"id":"hi","persona":{"role":"primary_eligible"},"compatibility":{"combine_priority":90}}));
        let lo = m(json!({"id":"lo","persona":{"role":"primary_eligible"},"compatibility":{"combine_priority":10}}));
        let merged = merge("BASE", &[hi, lo], Some("lo")).unwrap();
        assert_eq!(merged.primary, Some("lo".to_string())); // hint beats higher priority
        assert_eq!(merged.order, vec!["lo", "hi"]);
    }

    #[test]
    fn hint_ignored_when_not_primary_eligible() {
        let sec = m(json!({"id":"sec","persona":{"role":"secondary_only"},"compatibility":{"combine_priority":90}}));
        let elig = m(json!({"id":"elig","persona":{"role":"primary_eligible"},"compatibility":{"combine_priority":10}}));
        let merged = merge("BASE", &[sec, elig], Some("sec")).unwrap();
        assert_eq!(merged.primary, Some("elig".to_string())); // falls back to the only eligible one
    }

    #[test]
    fn same_tool_ref_same_config_is_a_shared_instance() {
        let a = m(json!({"id":"aaa","tools":[{"ref":"list_manage","config":{"list_id":"ingredients"}}]}));
        let b = m(json!({"id":"bbb","tools":[{"ref":"list_manage","config":{"list_id":"ingredients"}}]}));
        let merged = merge("BASE", &[a, b], None).unwrap();
        assert_eq!(merged.tools.len(), 1);
        let t = &merged.tools[0];
        assert_eq!(t.call_name, "list_manage");
        assert!(!t.namespaced);
        assert_eq!(t.contributors.len(), 2);
    }

    #[test]
    fn same_tool_ref_differing_config_forces_namespaced_variants() {
        let a = m(json!({"id":"cooking","tools":[{"ref":"list_manage","config":{"list_id":"ingredients"}}]}));
        let b = m(json!({"id":"packing","tools":[{"ref":"list_manage","config":{"list_id":"luggage"}}]}));
        let merged = merge("BASE", &[a, b], None).unwrap();
        let names: Vec<&str> = merged.tools.iter().map(|t| t.call_name.as_str()).collect();
        assert_eq!(names, vec!["cooking.list_manage", "packing.list_manage"]);
        assert!(merged.tools.iter().all(|t| t.namespaced));
    }

    #[test]
    fn distinct_tool_refs_are_all_present_and_sorted() {
        let a = m(json!({"id":"aaa","tools":[{"ref":"start_timer"},{"ref":"convert_units"}]}));
        let b = m(json!({"id":"bbb","tools":[{"ref":"list_manage"}]}));
        let merged = merge("BASE", &[a, b], None).unwrap();
        let names: Vec<&str> = merged.tools.iter().map(|t| t.call_name.as_str()).collect();
        assert_eq!(names, vec!["convert_units", "list_manage", "start_timer"]);
    }

    #[test]
    fn conflicting_skills_are_blocked() {
        let a = m(json!({"id":"aaa","compatibility":{"conflicts_with":["bbb"]}}));
        let b = m(json!({"id":"bbb"}));
        let err = merge("BASE", &[a, b], None).unwrap_err();
        assert_eq!(err, MergeError::Conflict { a: "aaa".to_string(), b: "bbb".to_string() });
    }

    #[test]
    fn default_combine_priority_is_50_when_absent() {
        let a = m(json!({"id":"aaa","persona":{"role":"primary_eligible"}}));
        assert_eq!(a.compatibility.combine_priority, 50);
    }
}
