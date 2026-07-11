#![allow(dead_code)] // Phase-1 templates core; wired into the SQLite store + IPC layer in a later ticket.

//! Agent templates: save / load a named skill combination, with version pinning
//! (P1-07.1-.4, SPEC §10 and §8.6).
//!
//! A **template** is the saved, named configuration a user reloads later
//! ("Weeknight Chef"): *which skills are active (id + version pin), the
//! base-model choice, panel layout overrides, and optional persisted panel
//! presets* (SPEC §10). It is stored locally as a JSON document (SPEC §6/§10),
//! so the model type here is a plain serde document.
//!
//! This module is the pure core behind the two verbs in §10:
//!
//!  - **Save** (P1-07.2, "Save current agent as template…"): [`save_as_template`]
//!    captures the *current* agent's combo — the ordered set of enabled skills
//!    with the version each is running — plus the base model and the opaque UI
//!    overrides, into a [`Template`].
//!  - **Load** (P1-07.3, "pick from list → the exact combination + layout is
//!    restored"): [`load_template`] resolves each pinned [`SkillRef`] against the
//!    skills actually installed on this host. It restores the ordered combo and
//!    the UI overrides, or explains *why* it can't:
//!      - a removed/uninstalled skill → [`TemplateError::MissingSkill`] (the app
//!        "explains and offers to reinstall", §10);
//!      - an installed version outside the pin → [`TemplateError::VersionIncompatible`].
//!
//! ## Version pinning (P1-07.4, SPEC §8.6)
//! "Templates pin skill version constraints so a saved agent reloads with
//! compatible behavior. Updates are opt-in when online; already-installed
//! versions keep working offline until the user updates. Breaking changes bump
//! the major version and prompt the user before altering a saved template."
//!
//! We model a pin as a small semver **range** ([`VersionConstraint`]): `=1.2.0`
//! (exact), `>=1.2.0` (at-least), or `^1.2.0` (caret / same-major-compatible).
//! Loading is *not* an update — it only checks the installed version against the
//! pin. Updating is the separate, opt-in [`check_updates`], which reports each
//! available newer version and **flags a major bump as breaking** so the caller
//! can prompt before adopting it.
//!
//! ## Self-contained by design
//! Pure Rust (serde / serde_json), no Tauri / SQLite / inference coupling, so it
//! is unit-testable under the toolchain-free `mock-inference` build
//! (`cargo test --no-default-features --features mock-inference`). Per the ticket
//! it deliberately **duplicates a tiny [`SemVer`]** rather than editing
//! `skill_manager.rs`; the two are byte-identical in parsing/ordering and are
//! meant to be unified when a shared `version` module is extracted. It also
//! derives the template id from the name (a `tmpl_<slug>` per the §10 example)
//! instead of pulling in a UUID dependency, keeping the core dependency-free.
//!
//! ── Registration (hand-off for the lead) ───────────────────────────────────
//! Add `mod templates;` beside the other `mod` lines in `main.rs`. Persistence
//! (the SQLite "My Templates" store, §6/§10) and the IPC surface (save/load from
//! the gallery UI) are separate tickets; this module is the pure core they drive.

use serde::{Deserialize, Serialize};

// ===========================================================================
// Semver (small, self-contained — deliberately duplicated from skill_manager.rs
// per the ticket, to avoid editing that module; unify later in a `version` mod)
// ===========================================================================

/// A minimal semantic version: the `major.minor.patch` **release core** only.
///
/// Skills ship release versions (`"1.0.0"`, `"1.2.0"` — SPEC §8.2), so the
/// documented simplification is: pre-release / build metadata (`-rc.1`, `+build`)
/// is **stripped and ignored** for ordering. Comparison is the natural
/// field-wise order (derived `Ord` compares `major`, then `minor`, then `patch`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(try_from = "String")]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl SemVer {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self { major, minor, patch }
    }
}

impl std::str::FromStr for SemVer {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // Drop any pre-release/build suffix; order on the release core only.
        let core = s.split(|c| c == '-' || c == '+').next().unwrap_or(s).trim();
        if core.is_empty() {
            return Err(format!("empty version string: '{s}'"));
        }
        let mut nums = [0u64; 3];
        for (i, part) in core.split('.').enumerate() {
            if i >= 3 {
                return Err(format!("too many version components in '{s}'"));
            }
            nums[i] = part
                .parse::<u64>()
                .map_err(|_| format!("invalid version component '{part}' in '{s}'"))?;
        }
        Ok(SemVer { major: nums[0], minor: nums[1], patch: nums[2] })
    }
}

impl TryFrom<String> for SemVer {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl std::fmt::Display for SemVer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

// ===========================================================================
// Version constraints — the pin a template stores (P1-07.4, SPEC §8.6)
// ===========================================================================

/// The comparison a [`VersionConstraint`] applies to an installed version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOp {
    /// `=1.2.0` — only that exact release core.
    Exact,
    /// `>=1.2.0` — that version or any later one (the §10 example form).
    GreaterEq,
    /// `^1.2.0` — same-major-compatible: `>=1.2.0` and `< the next breaking
    /// version` (the left-most non-zero component bumped: `^1.2.0` ⇒ `<2.0.0`,
    /// `^0.2.0` ⇒ `<0.3.0`, `^0.0.3` ⇒ `<0.0.4`).
    Caret,
}

/// A saved version pin: an operator over a base [`SemVer`]. Serializes to/from
/// the compact string form the §10 document uses (`">=1.2.0"`, `"^1.2.0"`,
/// `"=1.2.0"`). A bare version (`"1.2.0"`) parses as [`RangeOp::Exact`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct VersionConstraint {
    pub op: RangeOp,
    pub base: SemVer,
}

impl VersionConstraint {
    pub const fn exact(base: SemVer) -> Self {
        Self { op: RangeOp::Exact, base }
    }
    pub const fn at_least(base: SemVer) -> Self {
        Self { op: RangeOp::GreaterEq, base }
    }
    pub const fn caret(base: SemVer) -> Self {
        Self { op: RangeOp::Caret, base }
    }

    /// Does an installed `version` satisfy this pin?
    pub fn matches(&self, version: &SemVer) -> bool {
        match self.op {
            RangeOp::Exact => *version == self.base,
            RangeOp::GreaterEq => *version >= self.base,
            RangeOp::Caret => *version >= self.base && *version < caret_ceiling(self.base),
        }
    }
}

/// The exclusive upper bound of a caret range: the next *breaking* version above
/// `base` (the left-most non-zero component bumped, the rest zeroed).
fn caret_ceiling(base: SemVer) -> SemVer {
    if base.major > 0 {
        SemVer::new(base.major + 1, 0, 0)
    } else if base.minor > 0 {
        SemVer::new(0, base.minor + 1, 0)
    } else {
        SemVer::new(0, 0, base.patch + 1)
    }
}

impl std::str::FromStr for VersionConstraint {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        // Order matters: match ">=" before the bare "=" / "^" prefixes.
        let (op, rest) = if let Some(r) = s.strip_prefix(">=") {
            (RangeOp::GreaterEq, r)
        } else if let Some(r) = s.strip_prefix('^') {
            (RangeOp::Caret, r)
        } else if let Some(r) = s.strip_prefix('=') {
            (RangeOp::Exact, r)
        } else {
            // A bare version pins exactly (the conservative default).
            (RangeOp::Exact, s)
        };
        let base: SemVer = rest.trim().parse()?;
        Ok(Self { op, base })
    }
}

impl TryFrom<String> for VersionConstraint {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl std::fmt::Display for VersionConstraint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let op = match self.op {
            RangeOp::Exact => "=",
            RangeOp::GreaterEq => ">=",
            RangeOp::Caret => "^",
        };
        write!(f, "{op}{}", self.base)
    }
}

impl Serialize for VersionConstraint {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ===========================================================================
// Template document (P1-07.1, SPEC §10)
// ===========================================================================

/// One pinned member of a saved combo: a skill id + the version range that must
/// be satisfied to load it (SPEC §10 `skills[]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillRef {
    pub skill_id: String,
    pub version_constraint: VersionConstraint,
}

/// A saved, named agent configuration (SPEC §10). Stored as a local JSON
/// document; reloadable from the "My Templates" gallery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    /// Stable local id (`tmpl_<slug-of-name>`, per the §10 example).
    pub id: String,
    /// The user-facing name ("Weeknight Chef").
    pub name: String,
    /// The active skills, **in composed/merge order** (§8.3), each with its pin.
    pub skill_refs: Vec<SkillRef>,
    /// The base-model choice — an opaque model identifier (e.g. the GGUF id
    /// `"qwen2.5-3b-instruct-q4_k_m"`, §8.5); this core does not interpret it.
    pub base_model: String,
    /// Opaque panel/layout overrides (SPEC §9/§10 `ui_overrides`, e.g.
    /// `{"panel_order":[...]}`). Stored verbatim; the UI layer owns its shape.
    pub ui_overrides: serde_json::Value,
    /// Optional persisted panel presets (§10 "optional persisted panel presets";
    /// shared-state/widget snapshots, §8.3.4/§9.9). Opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presets: Option<serde_json::Value>,
}

impl Template {
    /// Attach optional persisted panel presets (§10). Builder-style so the
    /// primary [`save_as_template`] signature stays the four core inputs.
    pub fn with_presets(mut self, presets: serde_json::Value) -> Self {
        self.presets = Some(presets);
        self
    }
}

/// A skill successfully resolved out of a template against the installed set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSkill {
    pub skill_id: String,
    /// The installed version that satisfied the pin (what actually runs).
    pub version: SemVer,
    /// The pin it satisfied (kept for display / opt-in update prompts).
    pub constraint: VersionConstraint,
}

/// The restored agent produced by [`load_template`]: the exact ordered combo plus
/// the layout to reapply (SPEC §10 "the exact skill combination + layout").
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAgent {
    pub base_model: String,
    /// Skills in template (merge) order — the combo to re-enable.
    pub skills: Vec<ResolvedSkill>,
    pub ui_overrides: serde_json::Value,
    pub presets: Option<serde_json::Value>,
}

// ===========================================================================
// Errors + update info
// ===========================================================================

/// Why a template cannot be loaded as-is (SPEC §10 load rules, §8.6 pinning).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    /// A referenced skill is not installed on this host — the app should explain
    /// and offer to reinstall it (§10). Names the skill so the message can too.
    MissingSkill { skill_id: String },
    /// The installed version is outside the template's pin (§8.6). The user can
    /// update the pin (opt-in) or install a matching version.
    VersionIncompatible { skill_id: String, required: VersionConstraint, installed: SemVer },
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TemplateError::MissingSkill { skill_id } => write!(
                f,
                "skill '{skill_id}' referenced by this template is not installed: reinstall it to load the template"
            ),
            TemplateError::VersionIncompatible { skill_id, required, installed } => write!(
                f,
                "skill '{skill_id}' is installed at {installed}, which does not satisfy the template's pin '{required}'"
            ),
        }
    }
}

impl std::error::Error for TemplateError {}

/// One available, opt-in update to a pinned skill (P1-07.4, §8.6). `breaking` is
/// set when the update crosses a **major** version (the "prompt before altering a
/// saved template" case).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub skill_id: String,
    /// The version the template is currently pinned at (the pin's base).
    pub from: SemVer,
    /// The newest available version above `from`.
    pub to: SemVer,
    /// True iff `to` is a higher major than `from` (a breaking bump, §8.6).
    pub breaking: bool,
}

// ===========================================================================
// Operations
// ===========================================================================

/// **Save current agent as template** (P1-07.2, SPEC §10).
///
/// Captures the current combo: `enabled` is the ordered list of active skills
/// `(skill_id, running_version)` — already in composed/merge order (§8.3). Each
/// is pinned as `>= running_version`, the §10 example form: the saved agent
/// reloads with that version *or newer* (newer is adopted only via the opt-in
/// [`check_updates`] flow). `ui_overrides` is stored verbatim.
///
/// The id is derived deterministically from `name` (`tmpl_<slug>`), so no UUID
/// dependency is pulled into this pure core.
pub fn save_as_template(
    name: impl Into<String>,
    base_model: impl Into<String>,
    enabled: &[(&str, SemVer)],
    ui_overrides: serde_json::Value,
) -> Template {
    let name = name.into();
    let skill_refs = enabled
        .iter()
        .map(|(id, version)| SkillRef {
            skill_id: (*id).to_string(),
            version_constraint: VersionConstraint::at_least(*version),
        })
        .collect();
    Template {
        id: template_id(&name),
        name,
        skill_refs,
        base_model: base_model.into(),
        ui_overrides,
        presets: None,
    }
}

/// **Load a template** (P1-07.3, SPEC §10).
///
/// Resolves each [`SkillRef`], in template order, against `installed`
/// (`(skill_id, installed_version)` for every skill present on this host):
///
///  - not installed → [`TemplateError::MissingSkill`] (explain + reinstall, §10);
///  - installed but outside the pin → [`TemplateError::VersionIncompatible`].
///
/// On success returns the ordered combo to re-enable plus the layout to reapply.
/// Fails fast on the first unsatisfiable ref.
pub fn load_template(
    template: &Template,
    installed: &[(&str, SemVer)],
) -> Result<ResolvedAgent, TemplateError> {
    let mut skills = Vec::with_capacity(template.skill_refs.len());
    for skill_ref in &template.skill_refs {
        let installed_version = installed
            .iter()
            .find(|(id, _)| *id == skill_ref.skill_id)
            .map(|(_, v)| *v)
            .ok_or_else(|| TemplateError::MissingSkill { skill_id: skill_ref.skill_id.clone() })?;

        if !skill_ref.version_constraint.matches(&installed_version) {
            return Err(TemplateError::VersionIncompatible {
                skill_id: skill_ref.skill_id.clone(),
                required: skill_ref.version_constraint,
                installed: installed_version,
            });
        }

        skills.push(ResolvedSkill {
            skill_id: skill_ref.skill_id.clone(),
            version: installed_version,
            constraint: skill_ref.version_constraint,
        });
    }

    Ok(ResolvedAgent {
        base_model: template.base_model.clone(),
        skills,
        ui_overrides: template.ui_overrides.clone(),
        presets: template.presets.clone(),
    })
}

/// **Opt-in update check** (P1-07.4, SPEC §8.6).
///
/// For each pinned skill, finds the newest version in `available` (the versions
/// on offer for that skill id — pass the latest per skill, or every version;
/// this takes the max) and, if it is strictly newer than the pin's base, reports
/// an [`UpdateInfo`]. `breaking` is set when the update crosses a **major**
/// version, so the caller can "prompt the user before altering a saved template".
///
/// This never mutates the template — adopting an update is the caller's choice.
/// Results follow the template's skill order.
pub fn check_updates(template: &Template, available: &[(&str, SemVer)]) -> Vec<UpdateInfo> {
    let mut updates = Vec::new();
    for skill_ref in &template.skill_refs {
        let latest = available
            .iter()
            .filter(|(id, _)| *id == skill_ref.skill_id)
            .map(|(_, v)| *v)
            .max();
        let from = skill_ref.version_constraint.base;
        if let Some(to) = latest {
            if to > from {
                updates.push(UpdateInfo {
                    skill_id: skill_ref.skill_id.clone(),
                    from,
                    to,
                    breaking: to.major > from.major,
                });
            }
        }
    }
    updates
}

/// Derive a stable local template id from its name: `tmpl_<slug>`, where the slug
/// lowercases alphanumerics and collapses every other run into a single `_`
/// (`"Weeknight Chef"` → `"tmpl_weeknight_chef"`, per the §10 example). An
/// empty/symbol-only name falls back to `tmpl_untitled`.
fn template_id(name: &str) -> String {
    let mut slug = String::new();
    let mut pending_sep = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_sep && !slug.is_empty() {
                slug.push('_');
            }
            slug.push(c.to_ascii_lowercase());
            pending_sep = false;
        } else {
            pending_sep = true;
        }
    }
    if slug.is_empty() {
        slug.push_str("untitled");
    }
    format!("tmpl_{slug}")
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ver(major: u64, minor: u64, patch: u64) -> SemVer {
        SemVer::new(major, minor, patch)
    }

    // ---- save -> load round-trip restores the combo + ui_overrides ----------

    #[test]
    fn save_captures_ordered_combo_and_pins_at_least() {
        let ui = json!({ "panel_order": ["timers", "ingredients", "nutrition"] });
        let tpl = save_as_template(
            "Weeknight Chef",
            "qwen2.5-3b-instruct-q4_k_m",
            &[("cooking-assistant", ver(1, 2, 0)), ("nutrition-coach", ver(1, 0, 0))],
            ui.clone(),
        );

        assert_eq!(tpl.id, "tmpl_weeknight_chef"); // §10 example id
        assert_eq!(tpl.name, "Weeknight Chef");
        assert_eq!(tpl.base_model, "qwen2.5-3b-instruct-q4_k_m");
        assert_eq!(tpl.ui_overrides, ui);
        assert_eq!(tpl.presets, None);
        // Ordered combo, each pinned `>=` its running version.
        let ids: Vec<&str> = tpl.skill_refs.iter().map(|r| r.skill_id.as_str()).collect();
        assert_eq!(ids, vec!["cooking-assistant", "nutrition-coach"]);
        assert_eq!(tpl.skill_refs[0].version_constraint, VersionConstraint::at_least(ver(1, 2, 0)));
        assert_eq!(tpl.skill_refs[1].version_constraint, VersionConstraint::at_least(ver(1, 0, 0)));
    }

    #[test]
    fn load_restores_exact_combo_order_and_layout() {
        let ui = json!({ "panel_order": ["timers", "ingredients", "nutrition"] });
        let tpl = save_as_template(
            "Weeknight Chef",
            "qwen2.5-3b-instruct-q4_k_m",
            &[("cooking-assistant", ver(1, 2, 0)), ("nutrition-coach", ver(1, 0, 0))],
            ui.clone(),
        );

        // Installed set is in a *different* order and cooking is a newer patch;
        // load must follow the template's order and accept the newer version.
        let resolved = load_template(
            &tpl,
            &[("nutrition-coach", ver(1, 0, 3)), ("cooking-assistant", ver(1, 4, 0))],
        )
        .unwrap();

        assert_eq!(resolved.base_model, "qwen2.5-3b-instruct-q4_k_m");
        assert_eq!(resolved.ui_overrides, ui); // layout restored verbatim
        let restored: Vec<(&str, SemVer)> =
            resolved.skills.iter().map(|s| (s.skill_id.as_str(), s.version)).collect();
        assert_eq!(
            restored,
            vec![("cooking-assistant", ver(1, 4, 0)), ("nutrition-coach", ver(1, 0, 3))],
            "combo restored in template order, at the installed versions"
        );
    }

    #[test]
    fn template_serde_json_round_trip_is_stable() {
        let tpl = save_as_template(
            "Weeknight Chef",
            "qwen2.5-3b-instruct-q4_k_m",
            &[("cooking-assistant", ver(1, 2, 0))],
            json!({ "panel_order": ["timers", "ingredients"] }),
        )
        .with_presets(json!({ "timers": [] }));

        let s = serde_json::to_string(&tpl).unwrap();
        let back: Template = serde_json::from_str(&s).unwrap();
        assert_eq!(back, tpl);

        // The pin serializes to the compact §10 string form.
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["skill_refs"][0]["version_constraint"], json!(">=1.2.0"));
    }

    #[test]
    fn deserializes_the_documented_pin_string_forms() {
        let raw = json!({
            "id": "tmpl_x",
            "name": "X",
            "skill_refs": [
                { "skill_id": "a", "version_constraint": ">=1.2.0" },
                { "skill_id": "b", "version_constraint": "^0.2.0" },
                { "skill_id": "c", "version_constraint": "=3.1.4" }
            ],
            "base_model": "m",
            "ui_overrides": {}
        });
        let tpl: Template = serde_json::from_value(raw).unwrap();
        assert_eq!(tpl.skill_refs[0].version_constraint, VersionConstraint::at_least(ver(1, 2, 0)));
        assert_eq!(tpl.skill_refs[1].version_constraint, VersionConstraint::caret(ver(0, 2, 0)));
        assert_eq!(tpl.skill_refs[2].version_constraint, VersionConstraint::exact(ver(3, 1, 4)));
        assert_eq!(tpl.presets, None); // absent -> None
    }

    // ---- missing skill -> MissingSkill naming it (§10) -----------------------

    #[test]
    fn missing_skill_is_reported_by_name() {
        let tpl = save_as_template(
            "Weeknight Chef",
            "m",
            &[("cooking-assistant", ver(1, 2, 0)), ("nutrition-coach", ver(1, 0, 0))],
            json!({}),
        );
        // nutrition-coach was uninstalled/removed.
        let err = load_template(&tpl, &[("cooking-assistant", ver(1, 2, 0))]).unwrap_err();
        assert_eq!(err, TemplateError::MissingSkill { skill_id: "nutrition-coach".to_string() });
        assert!(err.to_string().contains("nutrition-coach"), "message names the skill + reinstall");
        assert!(err.to_string().contains("reinstall"));
    }

    // ---- incompatible installed version -> VersionIncompatible (§8.6) --------

    #[test]
    fn installed_below_at_least_pin_is_incompatible() {
        let tpl = save_as_template("T", "m", &[("cooking-assistant", ver(1, 2, 0))], json!({}));
        // Installed 1.1.0 does not satisfy the `>=1.2.0` pin.
        let err = load_template(&tpl, &[("cooking-assistant", ver(1, 1, 0))]).unwrap_err();
        assert_eq!(
            err,
            TemplateError::VersionIncompatible {
                skill_id: "cooking-assistant".to_string(),
                required: VersionConstraint::at_least(ver(1, 2, 0)),
                installed: ver(1, 1, 0),
            }
        );
        assert!(err.to_string().contains("1.1.0") && err.to_string().contains(">=1.2.0"));
    }

    #[test]
    fn installed_above_caret_ceiling_is_incompatible() {
        // A hand-built template with a caret pin (upper-bounded).
        let tpl = Template {
            id: "tmpl_x".to_string(),
            name: "X".to_string(),
            skill_refs: vec![SkillRef {
                skill_id: "s".to_string(),
                version_constraint: VersionConstraint::caret(ver(1, 2, 0)),
            }],
            base_model: "m".to_string(),
            ui_overrides: json!({}),
            presets: None,
        };
        // 2.0.0 is beyond `^1.2.0`'s `<2.0.0` ceiling -> incompatible.
        let err = load_template(&tpl, &[("s", ver(2, 0, 0))]).unwrap_err();
        assert_eq!(
            err,
            TemplateError::VersionIncompatible {
                skill_id: "s".to_string(),
                required: VersionConstraint::caret(ver(1, 2, 0)),
                installed: ver(2, 0, 0),
            }
        );
        // ...but 1.9.9 satisfies the caret and loads.
        assert!(load_template(&tpl, &[("s", ver(1, 9, 9))]).is_ok());
    }

    // ---- version pinning: updates (P1-07.4, §8.6) ----------------------------

    #[test]
    fn check_updates_flags_major_breaking_but_not_minor() {
        let tpl = save_as_template(
            "Weeknight Chef",
            "m",
            &[("cooking-assistant", ver(1, 2, 0)), ("nutrition-coach", ver(1, 0, 0))],
            json!({}),
        );
        let updates = check_updates(
            &tpl,
            &[("cooking-assistant", ver(2, 0, 0)), ("nutrition-coach", ver(1, 3, 0))],
        );

        // Results follow template order.
        assert_eq!(updates.len(), 2);
        assert_eq!(
            updates[0],
            UpdateInfo {
                skill_id: "cooking-assistant".to_string(),
                from: ver(1, 2, 0),
                to: ver(2, 0, 0),
                breaking: true, // major bump -> prompt before altering the template
            }
        );
        assert_eq!(
            updates[1],
            UpdateInfo {
                skill_id: "nutrition-coach".to_string(),
                from: ver(1, 0, 0),
                to: ver(1, 3, 0),
                breaking: false, // minor bump -> non-breaking
            }
        );
    }

    #[test]
    fn check_updates_ignores_same_or_older_and_takes_the_max_available() {
        let tpl = save_as_template(
            "T",
            "m",
            &[("a", ver(1, 2, 0)), ("b", ver(1, 0, 0))],
            json!({}),
        );
        // `a` has only same/older on offer -> no update; `b` has several, take max.
        let updates = check_updates(
            &tpl,
            &[("a", ver(1, 2, 0)), ("a", ver(1, 1, 0)), ("b", ver(1, 1, 0)), ("b", ver(1, 4, 0))],
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].skill_id, "b");
        assert_eq!(updates[0].to, ver(1, 4, 0)); // newest, not the first seen
        assert!(!updates[0].breaking);
    }

    // ---- empty template ------------------------------------------------------

    #[test]
    fn empty_template_saves_loads_and_has_no_updates() {
        let ui = json!({ "panel_order": [] });
        let tpl = save_as_template("Empty", "m", &[], ui.clone());
        assert_eq!(tpl.id, "tmpl_empty");
        assert!(tpl.skill_refs.is_empty());

        let resolved = load_template(&tpl, &[]).unwrap();
        assert!(resolved.skills.is_empty());
        assert_eq!(resolved.ui_overrides, ui); // layout still restored
        assert_eq!(resolved.base_model, "m");

        assert!(check_updates(&tpl, &[("anything", ver(9, 9, 9))]).is_empty());
    }

    // ---- version-constraint primitive ---------------------------------------

    #[test]
    fn constraint_parses_all_documented_forms() {
        assert_eq!(">=1.2.0".parse::<VersionConstraint>().unwrap(), VersionConstraint::at_least(ver(1, 2, 0)));
        assert_eq!("^1.2.0".parse::<VersionConstraint>().unwrap(), VersionConstraint::caret(ver(1, 2, 0)));
        assert_eq!("=1.2.0".parse::<VersionConstraint>().unwrap(), VersionConstraint::exact(ver(1, 2, 0)));
        // A bare version pins exactly.
        assert_eq!("1.2.0".parse::<VersionConstraint>().unwrap(), VersionConstraint::exact(ver(1, 2, 0)));
        // Whitespace tolerated.
        assert_eq!(" >= 1.2.0 ".parse::<VersionConstraint>().unwrap(), VersionConstraint::at_least(ver(1, 2, 0)));
        // Garbage rejected.
        assert!(">1.2.0".parse::<VersionConstraint>().is_err()); // bare '>' unsupported
        assert!("^x.y".parse::<VersionConstraint>().is_err());
        assert!(">=".parse::<VersionConstraint>().is_err());
    }

    #[test]
    fn constraint_display_is_the_compact_form() {
        assert_eq!(VersionConstraint::at_least(ver(1, 2, 0)).to_string(), ">=1.2.0");
        assert_eq!(VersionConstraint::caret(ver(1, 2, 0)).to_string(), "^1.2.0");
        assert_eq!(VersionConstraint::exact(ver(3, 1, 4)).to_string(), "=3.1.4");
    }

    #[test]
    fn constraint_matching_semantics() {
        let ge = VersionConstraint::at_least(ver(1, 2, 0));
        assert!(ge.matches(&ver(1, 2, 0)));
        assert!(ge.matches(&ver(9, 0, 0)));
        assert!(!ge.matches(&ver(1, 1, 9)));

        let ex = VersionConstraint::exact(ver(1, 2, 0));
        assert!(ex.matches(&ver(1, 2, 0)));
        assert!(!ex.matches(&ver(1, 2, 1)));

        let caret = VersionConstraint::caret(ver(1, 2, 0));
        assert!(caret.matches(&ver(1, 2, 0)));
        assert!(caret.matches(&ver(1, 9, 9)));
        assert!(!caret.matches(&ver(2, 0, 0))); // next major is the ceiling
        assert!(!caret.matches(&ver(1, 1, 0))); // below the base

        // 0.x caret ceilings bump the left-most *non-zero* component.
        let c0 = VersionConstraint::caret(ver(0, 2, 0));
        assert!(c0.matches(&ver(0, 2, 9)));
        assert!(!c0.matches(&ver(0, 3, 0)));
        let c00 = VersionConstraint::caret(ver(0, 0, 3));
        assert!(c00.matches(&ver(0, 0, 3)));
        assert!(!c00.matches(&ver(0, 0, 4)));
    }

    #[test]
    fn template_id_slugifies_names() {
        assert_eq!(template_id("Weeknight Chef"), "tmpl_weeknight_chef");
        assert_eq!(template_id("  Spicy   Ramen!!  "), "tmpl_spicy_ramen");
        assert_eq!(template_id("Chef 2000"), "tmpl_chef_2000");
        assert_eq!(template_id("!!!"), "tmpl_untitled"); // symbol-only fallback
    }
}
