//! Phase-0 skills (P0-05.x). Two hardcoded skills mirror the real free/paid
//! split (SPEC §26.4, PHASE0-PLAN §3.4):
//!
//!  - **free** "Kitchen Timer & Units" — the H1 transform surface. Its enable
//!    path is already wired in `main.rs`'s `skill_enable` (it needs no persona
//!    file: it leads with the base preamble + the three tools).
//!  - **paid** "Cooking Assistant" ([`cooking_assistant`]) — the $5 H3 SKU. Its
//!    own persona, a recipe-steps affordance, and a receipt-unlock gate.
//!
//! The [`allergen`] layer is skill-independent, deterministic, and
//! safety-critical: it scans whatever ingredient text is on screen regardless
//! of which skill (or none) is active. It lives here, next to the skills, so it
//! ships with the app; the H2 harness reads its canonical data file directly.
//!
//! WIRING NOTE (for the lead — this crate's `main.rs` is not owned by this
//! change to avoid a write-collision with the in-flight llama.cpp edit): add
//! `mod skills;` to `main.rs` so these compile into the binary. No new crate
//! dependency is required (the allergen matcher is std-only; persona/recipe use
//! only `serde`, already a dependency).

pub mod allergen;
pub mod cooking_assistant;

/// The two Phase-0 skill ids, kebab-case to match `SkillId` on the IPC wire.
pub const SKILL_IDS: [&str; 2] = ["kitchen-timer", cooking_assistant::SKILL_ID];
