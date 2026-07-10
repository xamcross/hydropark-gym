//! The paid **Cooking Assistant** skill (P0-05.3, SPEC §17) — the $5 SKU the H3
//! willingness-to-pay test sells (PHASE0-PLAN §3.4, §4c).
//!
//! This is a *real, distinct* deliverable, not an alias of the free "Kitchen
//! Timer & Units" skill:
//!  - it has its own **persona / system prompt** (`persona.md`, embedded below)
//!    covering recipe guidance, substitutions, scaling to N servings, and
//!    step-by-step cooking with timers;
//!  - it adds a **recipe-steps affordance** ([`RecipeStep`]) where the assistant
//!    walks numbered steps and can start a timer for a step by reusing the
//!    existing `start_timer` tool (no new tool is introduced — see
//!    `client/IPC-CONTRACT.md`, three fixed tools);
//!  - it is **gated behind a receipt-unlock**. The lead is building the unlock
//!    flow separately; this module exposes an [`is_unlocked`]/[`set_unlocked`]
//!    boolean that flow will drive. It **defaults to LOCKED**.
//!
//! Like the rest of this crate, this module is authored, not compiled in the
//! current environment (no `cargo` — see Cargo.toml). The Angular counterpart
//! (the UI transform + locked state) lives under
//! `client/web/src/app/skills/cooking-assistant/` and IS exercised by
//! `npm run build`.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

/// The Cooking Assistant system prompt. Injected as the *primary voice*
/// (SPEC §8.3.1) when this skill leads — the equivalent of `skill_enable`
/// wiring for `kitchen-timer`, but with this persona instead of the base one.
pub const PERSONA: &str = include_str!("persona.md");

/// Stable id string matching `SkillId::CookingAssistant` on the wire
/// (`ipc.rs` serialises it kebab-case) and `'cooking-assistant'` in
/// `contract.ts`.
pub const SKILL_ID: &str = "cooking-assistant";

/// Flat Phase-0 price in whole US dollars (PHASE0-PLAN §4c: "flat $5"). Not a
/// pricing engine — a single constant for the one WTP SKU.
pub const PRICE_USD: u32 = 5;

// ---------------------------------------------------------------------------
// Paid-SKU gating (P0-05.3). Defaults LOCKED; the receipt->unlock flow (built
// separately by the lead, PHASE0-PLAN §4c) calls `set_unlocked(true)` after it
// redeems a valid one-time code. Deliberately a process-global AtomicBool: the
// throwaway prototype has no persistence (PHASE0-PLAN §3.1, state in memory),
// so "unlocked" lives for the session the redeem happened in. Phase 1 replaces
// this with the real Ed25519/device-binding license check (explicitly OUT of
// scope, §2) — do not grow that here.
// ---------------------------------------------------------------------------

static UNLOCKED: AtomicBool = AtomicBool::new(false);

/// Whether the paid Cooking Assistant has been unlocked this session. Enabling
/// the skill / injecting the persona MUST be refused while this is false.
pub fn is_unlocked() -> bool {
    UNLOCKED.load(Ordering::SeqCst)
}

/// Driven by the receipt->unlock flow after a valid redeem (or, in the H1/dev
/// build, a debug affordance). Returns the previous state.
pub fn set_unlocked(unlocked: bool) -> bool {
    UNLOCKED.swap(unlocked, Ordering::SeqCst)
}

/// Reason a caller may not lead with this skill yet — surfaced to the UI as the
/// locked state rather than silently no-oping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateResult {
    Unlocked,
    Locked,
}

/// The single gate the `skill_enable` command should consult before injecting
/// [`PERSONA`] for `cooking-assistant`. (Wiring note in the task report: the
/// lead adds a `SkillId::CookingAssistant => cooking_assistant::gate()` check to
/// `main.rs`'s `skill_enable`.)
pub fn gate() -> GateResult {
    if is_unlocked() {
        GateResult::Unlocked
    } else {
        GateResult::Locked
    }
}

// ---------------------------------------------------------------------------
// Recipe-steps affordance (the distinct UI concept for this skill).
// ---------------------------------------------------------------------------

/// A quantity on a recipe ingredient. Mirrors the fields of the IPC
/// `IngredientItem` so the assistant can hand these straight to `list_manage`
/// `set_all` and to the deterministic allergen scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeIngredient {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// If false, this quantity does NOT scale linearly with servings (salt,
    /// leavening) — the assistant is instructed to use judgement, not multiply.
    #[serde(default = "default_true")]
    pub scales_linearly: bool,
}

fn default_true() -> bool {
    true
}

/// One numbered step the assistant walks the user through. A step with a
/// `timer` offers to start a named `start_timer` for exactly that duration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeStep {
    pub number: u32,
    pub text: String,
    /// `Some((label, seconds))` when this step is time-bound and should offer a
    /// timer via the existing `start_timer` tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timer: Option<StepTimer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepTimer {
    pub label: String,
    pub duration_sec: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub title: String,
    /// Servings the `ingredients` quantities are written for.
    pub base_servings: u32,
    pub ingredients: Vec<RecipeIngredient>,
    pub steps: Vec<RecipeStep>,
}

impl Recipe {
    /// Linearly scale ingredient quantities to `target_servings`. Quantities on
    /// ingredients marked `scales_linearly = false` are left untouched (the
    /// persona tells the model to apply judgement to those). Exact arithmetic —
    /// no rounding here; display rounding is the UI's job, matching the
    /// deterministic `convert_units` contract.
    pub fn scaled_to(&self, target_servings: u32) -> Recipe {
        let factor = target_servings as f64 / self.base_servings as f64;
        let ingredients = self
            .ingredients
            .iter()
            .map(|ing| RecipeIngredient {
                name: ing.name.clone(),
                qty: ing.qty.map(|q| if ing.scales_linearly { q * factor } else { q }),
                unit: ing.unit.clone(),
                scales_linearly: ing.scales_linearly,
            })
            .collect();
        Recipe {
            title: self.title.clone(),
            base_servings: target_servings,
            ingredients,
            steps: self.steps.clone(),
        }
    }

    /// The ingredient names the deterministic allergen layer should scan
    /// (`skills::allergen::scan_ingredients`). Kept here so the app scans the
    /// authoritative recipe list, never model prose.
    pub fn ingredient_names(&self) -> Vec<String> {
        self.ingredients.iter().map(|i| i.name.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn carbonara() -> Recipe {
        Recipe {
            title: "Spaghetti Carbonara".into(),
            base_servings: 4,
            ingredients: vec![
                RecipeIngredient { name: "Spaghetti".into(), qty: Some(400.0), unit: Some("g".into()), scales_linearly: true },
                RecipeIngredient { name: "Egg yolks".into(), qty: Some(4.0), unit: None, scales_linearly: true },
                RecipeIngredient { name: "Salt".into(), qty: None, unit: None, scales_linearly: false },
            ],
            steps: vec![RecipeStep {
                number: 1,
                text: "Boil the pasta until al dente.".into(),
                timer: Some(StepTimer { label: "Pasta".into(), duration_sec: 540 }),
            }],
        }
    }

    #[test]
    fn defaults_locked() {
        // NOTE: process-global; if other tests flip it, this documents intent.
        assert_eq!(super::gate() == GateResult::Locked, !is_unlocked());
    }

    #[test]
    fn scaling_is_linear_and_exact() {
        let r = carbonara().scaled_to(6); // factor 1.5
        assert_eq!(r.base_servings, 6);
        assert_eq!(r.ingredients[0].qty, Some(600.0)); // 400 * 1.5
        assert_eq!(r.ingredients[1].qty, Some(6.0)); // 4 * 1.5
        assert_eq!(r.ingredients[2].qty, None); // salt does not scale
    }

    #[test]
    fn persona_is_real_not_stub() {
        assert!(PERSONA.len() > 500);
        assert!(PERSONA.contains("start_timer"));
        assert!(PERSONA.to_lowercase().contains("substitution"));
        assert!(PERSONA.to_lowercase().contains("allergen"));
    }
}
