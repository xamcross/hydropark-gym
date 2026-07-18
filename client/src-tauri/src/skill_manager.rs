#![allow(dead_code)] // Phase-1 lifecycle core; wired into the marketplace/IPC layer in a later ticket.

//! Skill ownership/install lifecycle + compatibility gating
//! (P1-03.5 / P1-03.6, SPEC §11.3 and §8.6).
//!
//! This is the state machine that sits between the marketplace (§11) and the
//! orchestrator's merge (§8.3, `orchestrator.rs`). The orchestrator composes the
//! set of *enabled* skills; this module decides which skills are *eligible to be
//! enabled* in the first place — a skill must be **owned**, **installed**,
//! **enabled**, and **compatible** with the host before it ever reaches `merge`.
//!
//! ## Ownership + install state machine (§11.3)
//! SPEC §11.3 draws the marketplace flow as:
//!
//! ```text
//!   Not owned ──(Buy)──▶ Owned/Not installed ──(Install)──▶ Installed
//!                                  ▲                             │
//!                                  └────────(Uninstall)──────────┤ (Enable)
//!                                                                ▼
//!                                                              Active
//! ```
//!
//! We model that as three orthogonal fields on [`SkillEntry`] — `ownership`,
//! `install_state`, `enabled` — and expose the composite position as
//! [`LifecycleState`]. The transitions ([`mark_owned`](SkillEntry::mark_owned),
//! [`install`](SkillEntry::install), [`uninstall`](SkillEntry::uninstall),
//! [`enable`](SkillEntry::enable), [`disable`](SkillEntry::disable)) are the only
//! way to move between positions, and each validates its precondition, rejecting
//! an illegal move with a typed [`SkillError`] instead of silently doing nothing.
//! "Owned skills can be uninstalled … and reinstalled anytime for free" (§11.3):
//! uninstall returns to *Owned/Not installed*, never to *Not owned*.
//!
//! ## Compatibility gating (§8.6)
//! "`min_app_version` and `requirements.min_model_tier` gate install/enable"
//! (§8.6). We therefore re-run [`check_compatibility`](SkillEntry::check_compatibility)
//! at **both** `install` and `enable` (a model can be swapped out between the two,
//! per the re-certification note in §8.6) and block with a clear
//! [`Incompatibility`] reason — never silently degrading.
//!
//! ## Minimal skill view
//! Deliberately independent of [`orchestrator::SkillManifest`], which carries only
//! the *composition* subset and does **not** expose `free`, `min_app_version`, or
//! `min_model_tier`. [`SkillView`] is our own minimal view of those governance
//! fields, deserialized from the same canonical manifest
//! (contracts/skill-manifest.schema.json, shape per SPEC §8.2); everything the
//! lifecycle doesn't need is ignored.
//!
//! Pure Rust, no Tauri/inference coupling, unit-tested at the bottom.
//!
//! ── Registration (hand-off for the lead) ───────────────────────────────────
//! Add `mod skill_manager;` beside the other `mod` lines in `main.rs`. No Tauri
//! `.manage()` state or command wiring is added here — the IPC surface
//! (own/install/enable from the marketplace UI) is a separate ticket; this module
//! is the pure core those commands will drive. Like the rest of the crate it is
//! authored but not compiled in this environment; the `#[cfg(test)]` block proves
//! the state machine and the gates on a first real `cargo test`.

use std::collections::BTreeMap;

use serde::Deserialize;

// ===========================================================================
// Semver (small, self-contained — no `semver` crate, to avoid a Cargo.toml edit)
// ===========================================================================

/// A minimal semantic version: the `major.minor.patch` **release core** only.
///
/// Skills ship release versions (`"1.0.0"`, `"1.2.0"` — SPEC §8.2), so the
/// documented simplification is: pre-release / build metadata (`-rc.1`, `+build`)
/// is **stripped and ignored** for ordering. Comparison is the natural
/// field-wise order (derived `Ord` compares `major`, then `minor`, then `patch`),
/// which is exactly semver precedence for release cores.
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
// Model tier (ordered Small < Mid < Large)
// ===========================================================================

/// The device's model-capability tier (SPEC §8.6 `requirements.min_model_tier`).
///
/// Ordered `Small < Mid < Large` — the derived `Ord` follows declaration order,
/// so a skill is compatible iff `skill.min_model_tier <= device_tier`. `Small`
/// is the [`Default`] (a skill declaring no requirement must still run on
/// minimum hardware) and was the reference base model at original certification
/// (Qwen2.5-3B, §8.5).
///
/// 2026-07-19: the bundled/default on-device model moved to Qwen2.5-7B-Instruct
/// (`inference.rs::real::MODEL_FILE`). Per §8.6 ("re-certification on model
/// change") this is formally a base-model change; existing skills stay
/// certified against the unchanged 3B eval suite until it's re-run against 7B.
/// This gate isn't wired to a live device probe yet (`HostEnv` is constructed
/// by callers, e.g. in tests, with no `HYDROPARK_MODEL_TIER` env reader today);
/// when it is, the 7B device should report `ModelTier::Mid`, not `Small` — and
/// since `Mid > Small`, that's a strict superset for every skill still gated at
/// `Small` (all current skills), so nothing that installs/enables today breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Deserialize)]
#[serde(try_from = "String")]
pub enum ModelTier {
    #[default]
    Small,
    Mid,
    Large,
}

impl std::str::FromStr for ModelTier {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "small" | "s" => Ok(ModelTier::Small),
            "mid" | "medium" | "m" => Ok(ModelTier::Mid),
            "large" | "l" => Ok(ModelTier::Large),
            other => Err(format!("unknown model tier '{other}'")),
        }
    }
}

impl TryFrom<String> for ModelTier {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl std::fmt::Display for ModelTier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            ModelTier::Small => "Small",
            ModelTier::Mid => "Mid",
            ModelTier::Large => "Large",
        };
        f.write_str(s)
    }
}

// ===========================================================================
// Host environment (the gating inputs: current app version + device tier)
// ===========================================================================

/// The two host facts the compatibility gate (§8.6) checks against: the running
/// **app version** and the detected **device model tier**. Passed into the
/// [`SkillManager`] (constant for a host boot) and re-read at every install/enable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostEnv {
    pub app_version: SemVer,
    pub model_tier: ModelTier,
}

impl HostEnv {
    pub fn new(app_version: SemVer, model_tier: ModelTier) -> Self {
        Self { app_version, model_tier }
    }
}

// ===========================================================================
// Ownership & install-state models
// ===========================================================================

/// Runtime ownership of a skill (SPEC §11.2/§11.3).
///
/// A **free** skill is *implicitly ownable* — it needs no purchase, so it is
/// always treated as owned. A **paid** skill is owned only once an entitlement
/// has been granted (`entitled: true`); the client sets this from a verified
/// license (§13.3). Until then it sits in *Not owned*.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    Free,
    Paid { entitled: bool },
}

/// Whether the skill's package is present on disk (§11.3). Owned skills toggle
/// freely between these two without re-purchase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallState {
    NotInstalled,
    Installed,
}

/// The composite position in the §11.3 flow, derived from
/// (`ownership`, `install_state`, `enabled`). This is the typed view of "where a
/// skill is" that the marketplace UI renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    /// A paid skill with no entitlement yet. (Free skills are never here.)
    NotOwned,
    /// Owned but the package is not on disk — the "Owned" tab, "Install" button.
    OwnedNotInstalled,
    /// Installed on disk but not contributing to any agent yet.
    InstalledDisabled,
    /// Installed *and* enabled — an active member of the composed agent (§8.3).
    EnabledActive,
}

// ===========================================================================
// Errors
// ===========================================================================

/// Why an incompatible skill is blocked at install/enable (SPEC §8.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incompatibility {
    /// The skill needs a newer app than the one running.
    TooNewForApp { required: SemVer, current: SemVer },
    /// The skill needs a bigger model than this device provides
    /// (the "needs a bigger model" badge, §8.6).
    ModelTierTooLow { required: ModelTier, device: ModelTier },
}

impl std::fmt::Display for Incompatibility {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Incompatibility::TooNewForApp { required, current } => {
                write!(f, "needs app version >= {required}, but this app is {current}")
            }
            Incompatibility::ModelTierTooLow { required, device } => {
                write!(f, "needs a {required} model or larger, but this device runs {device}")
            }
        }
    }
}

/// A rejected lifecycle transition or a failed compatibility gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillError {
    /// Tried to install a paid skill that has no entitlement (§11.3): must Buy first.
    NotOwned { id: String },
    /// The operation needs the package installed on disk (enable/disable/uninstall).
    NotInstalled { id: String },
    /// Tried to install a skill that is already installed.
    AlreadyInstalled { id: String },
    /// Compatibility gate failed at install/enable (§8.6).
    Incompatible { id: String, reason: Incompatibility },
    /// No skill with this id is registered in the [`SkillManager`].
    UnknownSkill { id: String },
}

impl std::fmt::Display for SkillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkillError::NotOwned { id } => write!(
                f,
                "skill '{id}' is not owned: a paid skill must be purchased before it can be installed"
            ),
            SkillError::NotInstalled { id } => {
                write!(f, "skill '{id}' is not installed")
            }
            SkillError::AlreadyInstalled { id } => {
                write!(f, "skill '{id}' is already installed")
            }
            SkillError::Incompatible { id, reason } => {
                write!(f, "skill '{id}' is incompatible with this host: {reason}")
            }
            SkillError::UnknownSkill { id } => {
                write!(f, "no skill '{id}' is registered with the manager")
            }
        }
    }
}

impl std::error::Error for SkillError {}

// ===========================================================================
// Minimal manifest view (our own — NOT orchestrator::SkillManifest)
// ===========================================================================

/// The minimal governance subset of a skill manifest the *lifecycle* needs
/// (SPEC §8.2 shape). Fields the lifecycle doesn't use are ignored;
/// composition-only fields live in [`orchestrator::SkillManifest`].
#[derive(Debug, Clone, Deserialize)]
pub struct SkillView {
    pub id: String,
    /// Pricing block (§8.2 `pricing`). The `free` flag lives at `pricing.free` in the
    /// canonical schema (contracts/skill-manifest.schema.json) — NOT at the manifest
    /// top level. Absent ⇒ default (`free = false`), the conservative "treat as paid /
    /// needs an entitlement" fallback.
    #[serde(default)]
    pub pricing: Pricing,
    /// Minimum app version (§8.6). Absent ⇒ `0.0.0` (no floor).
    #[serde(default = "default_min_app_version")]
    pub min_app_version: SemVer,
    /// `requirements.min_model_tier` (§8.6). Absent ⇒ `Small`.
    #[serde(default)]
    pub requirements: Requirements,
}

fn default_min_app_version() -> SemVer {
    SemVer::new(0, 0, 0)
}

/// The `pricing` block's governance subset (§8.2 `pricing`). Only `free` matters to
/// the lifecycle; `price_usd` / `price` (the amount) are the marketplace's concern and
/// are ignored here (no `deny_unknown_fields`, so a paid skill's price fields pass through).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Pricing {
    /// True for the onboarding free skills (§26.4); false (or absent) ⇒ paid.
    #[serde(default)]
    pub free: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Requirements {
    #[serde(default)]
    pub min_model_tier: ModelTier,
}

impl From<SkillView> for SkillEntry {
    fn from(v: SkillView) -> Self {
        SkillEntry::new(v.id, v.pricing.free, v.min_app_version, v.requirements.min_model_tier)
    }
}

// ===========================================================================
// SkillEntry — one skill's lifecycle position + the validated transitions
// ===========================================================================

/// One skill's full lifecycle record. The transition methods are the only
/// sanctioned way to mutate `ownership` / `install_state` / `enabled`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntry {
    pub id: String,
    pub ownership: Ownership,
    pub install_state: InstallState,
    pub enabled: bool,
    pub min_app_version: SemVer,
    pub min_model_tier: ModelTier,
    /// The manifest's `free` flag (kept alongside `ownership` as the static
    /// property of the skill; `ownership` is the runtime state derived from it).
    pub free: bool,
}

impl SkillEntry {
    /// A fresh entry at the *start* of the §11.3 flow: a paid skill begins
    /// *Not owned*; a free skill begins *Owned/Not installed* (implicitly ownable).
    pub fn new(
        id: impl Into<String>,
        free: bool,
        min_app_version: SemVer,
        min_model_tier: ModelTier,
    ) -> Self {
        let ownership = if free { Ownership::Free } else { Ownership::Paid { entitled: false } };
        Self {
            id: id.into(),
            ownership,
            install_state: InstallState::NotInstalled,
            enabled: false,
            min_app_version,
            min_model_tier,
            free,
        }
    }

    /// Is this skill owned? Free skills always are; paid skills only once entitled.
    pub fn is_owned(&self) -> bool {
        match self.ownership {
            Ownership::Free => true,
            Ownership::Paid { entitled } => entitled,
        }
    }

    /// The composite [`LifecycleState`] derived from the three fields.
    pub fn state(&self) -> LifecycleState {
        if !self.is_owned() {
            return LifecycleState::NotOwned;
        }
        match self.install_state {
            InstallState::NotInstalled => LifecycleState::OwnedNotInstalled,
            InstallState::Installed => {
                if self.enabled {
                    LifecycleState::EnabledActive
                } else {
                    LifecycleState::InstalledDisabled
                }
            }
        }
    }

    /// The §8.6 gate on its own, returning the typed reason. Pure — no mutation.
    pub fn check_compatibility(&self, env: &HostEnv) -> Result<(), Incompatibility> {
        if self.min_app_version > env.app_version {
            return Err(Incompatibility::TooNewForApp {
                required: self.min_app_version,
                current: env.app_version,
            });
        }
        if self.min_model_tier > env.model_tier {
            return Err(Incompatibility::ModelTierTooLow {
                required: self.min_model_tier,
                device: env.model_tier,
            });
        }
        Ok(())
    }

    fn gate(&self, env: &HostEnv) -> Result<(), SkillError> {
        self.check_compatibility(env)
            .map_err(|reason| SkillError::Incompatible { id: self.id.clone(), reason })
    }

    /// **Buy** (§11.3): grant the entitlement. Idempotent, and a no-op for a free
    /// skill (already implicitly owned). Never fails — the license is verified
    /// upstream (§13.3); this only records the result.
    pub fn mark_owned(&mut self) -> LifecycleState {
        if let Ownership::Paid { entitled } = &mut self.ownership {
            *entitled = true;
        }
        self.state()
    }

    /// **Install/Download** (§11.3). Requires ownership and passes the §8.6 gate.
    /// Leaves the skill installed-but-disabled.
    pub fn install(&mut self, env: &HostEnv) -> Result<LifecycleState, SkillError> {
        if !self.is_owned() {
            return Err(SkillError::NotOwned { id: self.id.clone() });
        }
        if self.install_state == InstallState::Installed {
            return Err(SkillError::AlreadyInstalled { id: self.id.clone() });
        }
        self.gate(env)?;
        self.install_state = InstallState::Installed;
        self.enabled = false;
        Ok(self.state())
    }

    /// **Uninstall** (§11.3): free the disk, keep ownership. Any enabled state is
    /// cleared en route. Returns to *Owned/Not installed*; reinstall is free.
    pub fn uninstall(&mut self) -> Result<LifecycleState, SkillError> {
        if self.install_state != InstallState::Installed {
            return Err(SkillError::NotInstalled { id: self.id.clone() });
        }
        self.install_state = InstallState::NotInstalled;
        self.enabled = false;
        Ok(self.state())
    }

    /// **Enable** → *Active* (§11.3). Requires the package installed and **re-runs
    /// the §8.6 gate** (the model may have changed since install). Idempotent.
    pub fn enable(&mut self, env: &HostEnv) -> Result<LifecycleState, SkillError> {
        if self.install_state != InstallState::Installed {
            return Err(SkillError::NotInstalled { id: self.id.clone() });
        }
        self.gate(env)?;
        self.enabled = true;
        Ok(self.state())
    }

    /// **Disable**: leave the composed agent but stay installed. Idempotent.
    pub fn disable(&mut self) -> Result<LifecycleState, SkillError> {
        if self.install_state != InstallState::Installed {
            return Err(SkillError::NotInstalled { id: self.id.clone() });
        }
        self.enabled = false;
        Ok(self.state())
    }
}

// ===========================================================================
// SkillManager — a registry of entries over a fixed host environment
// ===========================================================================

/// Owns the set of known skills for one host and drives their lifecycle against a
/// fixed [`HostEnv`]. `BTreeMap` keeps iteration deterministic (matching the
/// orchestrator's determinism guarantees, §8.3.2).
pub struct SkillManager {
    env: HostEnv,
    skills: BTreeMap<String, SkillEntry>,
}

impl SkillManager {
    pub fn new(env: HostEnv) -> Self {
        Self { env, skills: BTreeMap::new() }
    }

    pub fn env(&self) -> &HostEnv {
        &self.env
    }

    /// Update the host environment — e.g. the user downloaded a bigger model, so
    /// the device tier changed. Already-installed skills are *never* auto-disabled
    /// (§8.3.5), but the next `install`/`enable` re-gates against the new value.
    pub fn set_env(&mut self, env: HostEnv) {
        self.env = env;
    }

    pub fn insert(&mut self, entry: SkillEntry) {
        self.skills.insert(entry.id.clone(), entry);
    }

    /// Register a skill straight from its manifest JSON (the §8.2 shape). Parses
    /// the minimal [`SkillView`]; unrelated fields are ignored.
    pub fn insert_from_manifest(
        &mut self,
        manifest: serde_json::Value,
    ) -> Result<(), serde_json::Error> {
        let view: SkillView = serde_json::from_value(manifest)?;
        self.insert(view.into());
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&SkillEntry> {
        self.skills.get(id)
    }

    pub fn state(&self, id: &str) -> Result<LifecycleState, SkillError> {
        self.skills
            .get(id)
            .map(SkillEntry::state)
            .ok_or_else(|| SkillError::UnknownSkill { id: id.to_string() })
    }

    fn get_mut(&mut self, id: &str) -> Result<&mut SkillEntry, SkillError> {
        self.skills.get_mut(id).ok_or_else(|| SkillError::UnknownSkill { id: id.to_string() })
    }

    pub fn mark_owned(&mut self, id: &str) -> Result<LifecycleState, SkillError> {
        Ok(self.get_mut(id)?.mark_owned())
    }

    pub fn install(&mut self, id: &str) -> Result<LifecycleState, SkillError> {
        let env = self.env; // HostEnv is Copy — take it before the &mut borrow.
        self.get_mut(id)?.install(&env)
    }

    pub fn uninstall(&mut self, id: &str) -> Result<LifecycleState, SkillError> {
        self.get_mut(id)?.uninstall()
    }

    pub fn enable(&mut self, id: &str) -> Result<LifecycleState, SkillError> {
        let env = self.env;
        self.get_mut(id)?.enable(&env)
    }

    pub fn disable(&mut self, id: &str) -> Result<LifecycleState, SkillError> {
        self.get_mut(id)?.disable()
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env(app: &str, tier: ModelTier) -> HostEnv {
        HostEnv::new(app.parse().unwrap(), tier)
    }

    fn paid(id: &str, min_app: &str, tier: ModelTier) -> SkillEntry {
        SkillEntry::new(id, false, min_app.parse().unwrap(), tier)
    }

    fn free_skill(id: &str, min_app: &str, tier: ModelTier) -> SkillEntry {
        SkillEntry::new(id, true, min_app.parse().unwrap(), tier)
    }

    // ---- happy path: own -> install -> enable -> disable -> uninstall --------

    #[test]
    fn happy_path_full_lifecycle_via_manager() {
        let mut mgr = SkillManager::new(env("1.2.0", ModelTier::Large));
        mgr.insert(paid("cooking-assistant", "1.0.0", ModelTier::Small));

        assert_eq!(mgr.state("cooking-assistant").unwrap(), LifecycleState::NotOwned);
        assert_eq!(mgr.mark_owned("cooking-assistant").unwrap(), LifecycleState::OwnedNotInstalled);
        assert_eq!(mgr.install("cooking-assistant").unwrap(), LifecycleState::InstalledDisabled);
        assert_eq!(mgr.enable("cooking-assistant").unwrap(), LifecycleState::EnabledActive);
        assert_eq!(mgr.disable("cooking-assistant").unwrap(), LifecycleState::InstalledDisabled);
        assert_eq!(mgr.uninstall("cooking-assistant").unwrap(), LifecycleState::OwnedNotInstalled);

        // "reinstalled anytime for free" (§11.3): still owned, installs again.
        assert_eq!(mgr.install("cooking-assistant").unwrap(), LifecycleState::InstalledDisabled);
    }

    // ---- illegal transitions -------------------------------------------------

    #[test]
    fn cannot_enable_before_install() {
        let mut e = paid("x", "1.0.0", ModelTier::Small);
        e.mark_owned();
        let err = e.enable(&env("1.0.0", ModelTier::Small)).unwrap_err();
        assert_eq!(err, SkillError::NotInstalled { id: "x".to_string() });
    }

    #[test]
    fn cannot_install_unowned_paid_skill() {
        let mut e = paid("x", "1.0.0", ModelTier::Small);
        assert_eq!(e.state(), LifecycleState::NotOwned);
        let err = e.install(&env("1.0.0", ModelTier::Small)).unwrap_err();
        assert_eq!(err, SkillError::NotOwned { id: "x".to_string() });
        assert_eq!(e.state(), LifecycleState::NotOwned); // unchanged
    }

    #[test]
    fn cannot_enable_after_uninstall() {
        let good = env("1.0.0", ModelTier::Small);
        let mut e = paid("x", "1.0.0", ModelTier::Small);
        e.mark_owned();
        e.install(&good).unwrap();
        e.enable(&good).unwrap();
        e.uninstall().unwrap();
        assert_eq!(e.state(), LifecycleState::OwnedNotInstalled);
        let err = e.enable(&good).unwrap_err();
        assert_eq!(err, SkillError::NotInstalled { id: "x".to_string() });
    }

    #[test]
    fn cannot_install_twice() {
        let good = env("1.0.0", ModelTier::Small);
        let mut e = free_skill("x", "1.0.0", ModelTier::Small);
        e.install(&good).unwrap();
        let err = e.install(&good).unwrap_err();
        assert_eq!(err, SkillError::AlreadyInstalled { id: "x".to_string() });
    }

    #[test]
    fn cannot_uninstall_or_disable_when_not_installed() {
        let mut e = free_skill("x", "1.0.0", ModelTier::Small);
        assert_eq!(e.uninstall().unwrap_err(), SkillError::NotInstalled { id: "x".to_string() });
        assert_eq!(e.disable().unwrap_err(), SkillError::NotInstalled { id: "x".to_string() });
    }

    #[test]
    fn unknown_skill_is_reported() {
        let mut mgr = SkillManager::new(env("1.0.0", ModelTier::Small));
        assert_eq!(
            mgr.install("nope").unwrap_err(),
            SkillError::UnknownSkill { id: "nope".to_string() }
        );
    }

    // ---- compatibility gating: min_app_version (§8.6) ------------------------

    #[test]
    fn min_app_version_gate_blocks_a_skill_needing_a_newer_app() {
        let mut e = paid("x", "2.0.0", ModelTier::Small);
        e.mark_owned();
        // App is older than the skill requires -> blocked at install.
        let err = e.install(&env("1.5.0", ModelTier::Large)).unwrap_err();
        assert_eq!(
            err,
            SkillError::Incompatible {
                id: "x".to_string(),
                reason: Incompatibility::TooNewForApp {
                    required: SemVer::new(2, 0, 0),
                    current: SemVer::new(1, 5, 0),
                },
            }
        );
        assert_eq!(e.state(), LifecycleState::OwnedNotInstalled); // not installed

        // Exactly-equal app version is allowed (`<=`).
        assert_eq!(
            e.install(&env("2.0.0", ModelTier::Large)).unwrap(),
            LifecycleState::InstalledDisabled
        );
    }

    // ---- compatibility gating: min_model_tier (§8.6) -------------------------

    #[test]
    fn min_model_tier_gate_blocks_on_small_but_allows_on_large() {
        // A Mid-tier skill on a Small device -> blocked.
        let mut on_small = free_skill("mid-skill", "1.0.0", ModelTier::Mid);
        let err = on_small.install(&env("1.0.0", ModelTier::Small)).unwrap_err();
        assert_eq!(
            err,
            SkillError::Incompatible {
                id: "mid-skill".to_string(),
                reason: Incompatibility::ModelTierTooLow {
                    required: ModelTier::Mid,
                    device: ModelTier::Small,
                },
            }
        );

        // Same skill on a Large device -> allowed (Mid <= Large).
        let mut on_large = free_skill("mid-skill", "1.0.0", ModelTier::Mid);
        assert_eq!(
            on_large.install(&env("1.0.0", ModelTier::Large)).unwrap(),
            LifecycleState::InstalledDisabled
        );
    }

    #[test]
    fn gate_is_rechecked_at_enable_not_only_install() {
        // Installed fine on a Large device...
        let mut e = free_skill("mid-skill", "1.0.0", ModelTier::Mid);
        e.install(&env("1.0.0", ModelTier::Large)).unwrap();
        e.disable().unwrap();
        // ...then the model was swapped down to Small: enable must re-gate (§8.6).
        let err = e.enable(&env("1.0.0", ModelTier::Small)).unwrap_err();
        assert_eq!(
            err,
            SkillError::Incompatible {
                id: "mid-skill".to_string(),
                reason: Incompatibility::ModelTierTooLow {
                    required: ModelTier::Mid,
                    device: ModelTier::Small,
                },
            }
        );
    }

    // ---- ownership: free vs paid --------------------------------------------

    #[test]
    fn free_skill_installs_without_an_entitlement() {
        let mut e = free_skill("kitchen-timer", "1.0.0", ModelTier::Small);
        assert!(e.is_owned()); // implicitly ownable
        assert_eq!(e.state(), LifecycleState::OwnedNotInstalled); // never NotOwned
        assert_eq!(
            e.install(&env("1.0.0", ModelTier::Small)).unwrap(),
            LifecycleState::InstalledDisabled
        );
    }

    #[test]
    fn paid_skill_needs_entitled_true() {
        let good = env("1.0.0", ModelTier::Small);
        let mut e = paid("cooking-assistant", "1.0.0", ModelTier::Small);

        // Not entitled -> not owned -> install blocked.
        assert!(!e.is_owned());
        assert_eq!(e.install(&good).unwrap_err(), SkillError::NotOwned { id: "cooking-assistant".to_string() });

        // Grant the entitlement, then it installs.
        e.mark_owned();
        assert_eq!(e.ownership, Ownership::Paid { entitled: true });
        assert!(e.is_owned());
        assert_eq!(e.install(&good).unwrap(), LifecycleState::InstalledDisabled);
    }

    // ---- minimal manifest view parsing --------------------------------------

    #[test]
    fn parses_governance_subset_from_a_manifest() {
        // The §8.2 example manifest, plus fields the lifecycle ignores. `free` lives
        // under `pricing` per the canonical schema — a paid skill also carries a price.
        let manifest = json!({
            "id": "cooking-assistant",
            "version": "1.2.0",
            "status": "published",
            "pricing": { "free": false, "price_usd": 5 },
            "min_app_version": "1.0.0",
            "requirements": { "min_params_b": 3, "min_ram_gb": 8, "min_model_tier": "small" },
            "persona": { "role": "primary_eligible" }
        });
        let mut mgr = SkillManager::new(env("1.0.0", ModelTier::Small));
        mgr.insert_from_manifest(manifest).unwrap();

        let e = mgr.get("cooking-assistant").unwrap();
        assert!(!e.free);
        assert_eq!(e.min_app_version, SemVer::new(1, 0, 0));
        assert_eq!(e.min_model_tier, ModelTier::Small);
        assert_eq!(e.ownership, Ownership::Paid { entitled: false });
        assert_eq!(e.state(), LifecycleState::NotOwned);
    }

    #[test]
    fn free_flag_is_read_from_pricing_not_top_level() {
        // REGRESSION (F3): `free` is at `pricing.free` in the §8.2 schema, not the
        // manifest top level. A FREE skill must parse as free/owned; a stray top-level
        // `free` (not in the schema) must be ignored, never win over `pricing.free`.
        let manifest = json!({
            "id": "kitchen-timer",
            "version": "1.0.0",
            "status": "published",
            "pricing": { "free": true },
            "min_app_version": "1.0.0",
            // A decoy top-level `free: false` — the OLD code read this and mis-flagged
            // the free skill as paid; the fix reads `pricing.free` and ignores this.
            "free": false,
            "persona": { "role": "primary_eligible" }
        });
        let mut mgr = SkillManager::new(env("1.0.0", ModelTier::Small));
        mgr.insert_from_manifest(manifest).unwrap();

        let e = mgr.get("kitchen-timer").unwrap();
        assert!(e.free); // read from pricing.free (true), not the decoy top-level field
        assert_eq!(e.ownership, Ownership::Free);
        assert_eq!(e.state(), LifecycleState::OwnedNotInstalled); // implicitly owned, never NotOwned
    }

    #[test]
    fn manifest_defaults_apply_when_governance_fields_absent() {
        let manifest = json!({ "id": "bare" });
        let mut mgr = SkillManager::new(env("1.0.0", ModelTier::Small));
        mgr.insert_from_manifest(manifest).unwrap();

        let e = mgr.get("bare").unwrap();
        assert!(!e.free); // absent pricing -> free defaults false -> paid (conservative)
        assert_eq!(e.min_app_version, SemVer::new(0, 0, 0)); // no floor
        assert_eq!(e.min_model_tier, ModelTier::Small); // default tier
    }

    // ---- semver & tier primitives -------------------------------------------

    #[test]
    fn semver_parses_and_orders() {
        assert_eq!("1.2.3".parse::<SemVer>().unwrap(), SemVer::new(1, 2, 3));
        assert_eq!("1.2".parse::<SemVer>().unwrap(), SemVer::new(1, 2, 0));
        assert_eq!("2".parse::<SemVer>().unwrap(), SemVer::new(2, 0, 0));
        // pre-release/build metadata is stripped for ordering (release core only).
        assert_eq!("1.2.3-rc.1+build".parse::<SemVer>().unwrap(), SemVer::new(1, 2, 3));

        assert!(SemVer::new(1, 0, 0) < SemVer::new(1, 0, 1));
        assert!(SemVer::new(1, 2, 0) < SemVer::new(2, 0, 0));
        assert!(SemVer::new(1, 10, 0) > SemVer::new(1, 9, 9)); // numeric, not lexical

        assert!("x.y".parse::<SemVer>().is_err());
        assert!("".parse::<SemVer>().is_err());
        assert!("1.2.3.4".parse::<SemVer>().is_err());
    }

    #[test]
    fn model_tier_orders_and_parses() {
        assert!(ModelTier::Small < ModelTier::Mid);
        assert!(ModelTier::Mid < ModelTier::Large);
        assert_eq!("small".parse::<ModelTier>().unwrap(), ModelTier::Small);
        assert_eq!("Large".parse::<ModelTier>().unwrap(), ModelTier::Large);
        assert!("huge".parse::<ModelTier>().is_err());
        assert_eq!(ModelTier::default(), ModelTier::Small);
    }
}
