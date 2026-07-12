#![allow(dead_code)] // Phase-1 install-path core; some helpers are used only by main.rs wiring / tests.

//! `.hpskill` package format + the real skill install flow (P1-03.2, SPEC §8.8,
//! §11.3, §13.3, §13.8).
//!
//! A `.hpskill` file is a **zip container** holding:
//!   - `manifest.json` — the skill manifest, carrying its own detached
//!     `signature` (`ed25519:<base64>`) + `signing_key_id` (`kid`);
//!   - `assets/**` — sanitized SVGs (the icon + panel art, §9);
//!   - `strings/**.json` — localized string tables, one per BCP-47 locale.
//!
//! The manifest is signed exactly as the backend `io.hydropark.packaging.PackageSigner`
//! signs it: Ed25519 over the **RFC 8785 JCS** canonicalization of the manifest with
//! the two signature fields removed. Verification is delegated to
//! [`crate::package_verify`], which is cross-checked byte-for-byte against the shared
//! golden vector (`contracts/testdata/package-signing-golden.json`) — so this format is
//! signature-compatible with the backend by construction.
//!
//! ## Fail-closed
//! [`HpSkill::open_bytes`] rejects a package that is tampered, unsigned, signed by an
//! unknown `kid`, contains a path-traversal / absolute / non-`.svg`-or-`.json` entry, or
//! whose SVG could execute script. Nothing is trusted, extracted, registered, or
//! persisted unless the manifest signature verifies against the pinned trust set (§13.8).
//!
//! ## Asset sanitization (P1-03.4)
//! Every archive entry is checked against the **same** rules the manifest validator pins
//! (`manifest.rs`): [`crate::manifest::is_svg_asset_path`] for `.svg` paths and
//! [`crate::manifest::is_locale`] for `strings/<locale>.json`. Only the manifest is
//! signed — assets are not — so they are sanitized on their own merits (relative path,
//! no traversal, `.svg`/`.json` only) and SVGs additionally pass a conservative
//! content check (defense-in-depth on top of the webview CSP), rather than trusted.
//!
//! ## Install flow ([`SkillInstaller`])
//! `install → verify signature → re-validate manifest → compatibility gate
//! (min_app_version / min_model_tier) → extract sanitized assets to the skills dir →
//! register via the [`crate::skill_manager`] lifecycle → persist to the store`. The
//! compatibility gate runs **before** any disk write, so a blocked install leaves the
//! disk, the lifecycle registry, and the store untouched.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::manifest::{self, CanonicalManifest, ValidationIssue};
use crate::package_verify::{self, PackageTrustedKeys, PackageVerifyError};
use crate::skill_manager::{
    HostEnv, InstallState, LifecycleState, ModelTier, SemVer, SkillEntry, SkillError, SkillManager,
};
use crate::store::{Store, StoreError};

/// The single, top-level manifest entry a `.hpskill` must contain.
const MANIFEST_ENTRY: &str = "manifest.json";

/// Archive prefix under which localized string tables live.
const STRINGS_PREFIX: &str = "strings/";

/// Env var carrying the pinned package-signing trust set, as `kid=spkiB64` pairs
/// separated by `;` or `,` (mirrors `downloader`'s `HYDROPARK_MODEL_SIGNING_KEYS`).
/// Empty/unset ⇒ empty trust set ⇒ every install fails closed as `UnknownKid`.
const PACKAGE_KEYS_ENV: &str = "HYDROPARK_PACKAGE_SIGNING_KEYS";

/// Env override for the host app version used by the compatibility gate (falls back to
/// the crate's `CARGO_PKG_VERSION`).
const APP_VERSION_ENV: &str = "HYDROPARK_APP_VERSION";

/// Env override for the host model tier (`small`/`mid`) used by the gate (default `small`).
const MODEL_TIER_ENV: &str = "HYDROPARK_MODEL_TIER";

/// Upper bound on an archive entry name length (a crude anti-abuse cap).
const MAX_ENTRY_NAME_LEN: usize = 256;

// ===========================================================================
// Errors
// ===========================================================================

/// Why opening / installing a `.hpskill` failed. Every variant is a hard reject —
/// the format is fail-closed.
#[derive(Debug)]
pub enum HpSkillError {
    /// The bytes are not a readable zip archive.
    Zip(String),
    /// A filesystem read/write failed.
    Io(String),
    /// The archive has no top-level `manifest.json`.
    MissingManifest,
    /// `manifest.json` is not a JSON object.
    ManifestNotJson(String),
    /// An entry is neither the manifest, a sanitized `.svg`, nor a `strings/<locale>.json`.
    UnexpectedEntry(String),
    /// An entry name is absolute, escapes the package (`..`), or is otherwise unsafe.
    UnsafePath(String),
    /// An `.svg` entry failed the content sanitize check (script/handler/remote ref).
    UnsafeSvg(String),
    /// A `strings/<locale>.json` entry is not a JSON object.
    BadStrings(String),
    /// The manifest signature did not verify against the pinned trust set (§13.8).
    Verify(PackageVerifyError),
    /// The manifest failed the offline structural re-validation (§8.2).
    Manifest(Vec<ValidationIssue>),
    /// A lifecycle transition or the compatibility gate rejected the install (§8.6/§11.3).
    Lifecycle(SkillError),
    /// The on-device store operation (persist / remove) failed.
    Store(String),
    /// The manifest's `min_app_version` was not parseable as a version.
    BadVersion(String),
    /// The manifest's `requirements.min_model_tier` was not a known tier.
    BadTier(String),
    /// A managed lock was poisoned by a prior panic.
    Poisoned,
}

impl std::fmt::Display for HpSkillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HpSkillError::Zip(m) => write!(f, "not a readable .hpskill archive: {m}"),
            HpSkillError::Io(m) => write!(f, "filesystem error: {m}"),
            HpSkillError::MissingManifest => write!(f, "package has no top-level manifest.json"),
            HpSkillError::ManifestNotJson(m) => write!(f, "manifest.json is not valid JSON: {m}"),
            HpSkillError::UnexpectedEntry(n) => {
                write!(f, "package entry '{n}' is not a sanitized .svg or strings/<locale>.json")
            }
            HpSkillError::UnsafePath(n) => write!(f, "unsafe package entry path '{n}' (traversal/absolute)"),
            HpSkillError::UnsafeSvg(n) => write!(f, "SVG asset '{n}' failed the content sanitize check"),
            HpSkillError::BadStrings(m) => write!(f, "localized strings entry is not a JSON object: {m}"),
            HpSkillError::Verify(e) => write!(f, "package signature verification failed: {e}"),
            HpSkillError::Manifest(issues) => {
                write!(f, "manifest failed re-validation: ")?;
                for (i, issue) in issues.iter().enumerate() {
                    if i > 0 {
                        write!(f, "; ")?;
                    }
                    write!(f, "{issue}")?;
                }
                Ok(())
            }
            HpSkillError::Lifecycle(e) => write!(f, "{e}"),
            HpSkillError::Store(m) => write!(f, "on-device store error: {m}"),
            HpSkillError::BadVersion(m) => write!(f, "manifest min_app_version is invalid: {m}"),
            HpSkillError::BadTier(m) => write!(f, "manifest min_model_tier is invalid: {m}"),
            HpSkillError::Poisoned => write!(f, "skill installer lock was poisoned"),
        }
    }
}

impl std::error::Error for HpSkillError {}

impl From<zip::result::ZipError> for HpSkillError {
    fn from(e: zip::result::ZipError) -> Self {
        HpSkillError::Zip(e.to_string())
    }
}

impl From<std::io::Error> for HpSkillError {
    fn from(e: std::io::Error) -> Self {
        HpSkillError::Io(e.to_string())
    }
}

impl From<StoreError> for HpSkillError {
    fn from(e: StoreError) -> Self {
        HpSkillError::Store(e.to_string())
    }
}

// ===========================================================================
// Opened package
// ===========================================================================

/// One sanitized, extracted-in-memory package resource (an asset or a strings file).
/// `path` is a validated, package-relative path (forward-slashes, no `..`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageEntry {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// A verified, sanitized `.hpskill` package held in memory. Constructing one proves the
/// manifest signature verified against the trust set and every asset/string entry passed
/// sanitization; it does not yet touch the disk or the lifecycle.
#[derive(Debug, Clone)]
pub struct HpSkill {
    /// The verified raw manifest.
    pub manifest: Value,
    /// The exact `manifest.json` bytes read from the archive (written back verbatim on
    /// extract, so the on-disk copy still verifies).
    pub manifest_bytes: Vec<u8>,
    /// Sanitized `.svg` assets.
    pub assets: Vec<PackageEntry>,
    /// Localized `strings/<locale>.json` tables.
    pub strings: Vec<PackageEntry>,
}

impl HpSkill {
    /// Open a `.hpskill` from a filesystem path (reads it, then [`Self::open_bytes`]).
    pub fn open_path(path: &Path, trusted: &PackageTrustedKeys) -> Result<Self, HpSkillError> {
        let bytes = fs::read(path)?;
        Self::open_bytes(&bytes, trusted)
    }

    /// Open a `.hpskill` from its raw bytes: unzip, sanitize every entry, then
    /// **verify the manifest signature** against `trusted`. Fail-closed on any
    /// unsafe entry, a missing manifest, or a signature that does not verify.
    pub fn open_bytes(bytes: &[u8], trusted: &PackageTrustedKeys) -> Result<Self, HpSkillError> {
        let reader = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader)?;

        let mut manifest_bytes: Option<Vec<u8>> = None;
        let mut assets: Vec<PackageEntry> = Vec::new();
        let mut strings: Vec<PackageEntry> = Vec::new();

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let name = file.name().to_string();

            // Skip directory entries (they carry no bytes and create no files).
            if name.ends_with('/') {
                continue;
            }
            // Reject traversal / absolute / backslash / drive-colon / control-char names
            // up front, before any classification — this is the path-traversal guard.
            if !safe_relative_path(&name) {
                return Err(HpSkillError::UnsafePath(name));
            }

            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;

            if name == MANIFEST_ENTRY {
                if manifest_bytes.is_some() {
                    return Err(HpSkillError::UnexpectedEntry(format!("duplicate {MANIFEST_ENTRY}")));
                }
                manifest_bytes = Some(buf);
            } else if manifest::is_svg_asset_path(&name) {
                // Same "sanitized-SVG path" rule the manifest pins, plus a content check.
                if !svg_content_is_safe(&buf) {
                    return Err(HpSkillError::UnsafeSvg(name));
                }
                assets.push(PackageEntry { path: name, bytes: buf });
            } else if strings_locale(&name).is_some() {
                // Localized strings must be a JSON object (a key -> message map).
                let parsed: Value = serde_json::from_slice(&buf)
                    .map_err(|e| HpSkillError::BadStrings(format!("{name}: {e}")))?;
                if !parsed.is_object() {
                    return Err(HpSkillError::BadStrings(format!("{name}: not a JSON object")));
                }
                strings.push(PackageEntry { path: name, bytes: buf });
            } else {
                return Err(HpSkillError::UnexpectedEntry(name));
            }
        }

        let manifest_bytes = manifest_bytes.ok_or(HpSkillError::MissingManifest)?;
        let manifest: Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| HpSkillError::ManifestNotJson(e.to_string()))?;
        if !manifest.is_object() {
            return Err(HpSkillError::ManifestNotJson(
                "manifest.json is not a JSON object".to_string(),
            ));
        }

        // THE fail-closed gate: the detached Ed25519/JCS signature must verify against a
        // pinned key before this package is considered valid (§13.3 / §13.8).
        package_verify::verify(&manifest, trusted).map_err(HpSkillError::Verify)?;

        Ok(HpSkill { manifest, manifest_bytes, assets, strings })
    }

    /// Write the verified manifest + sanitized assets/strings under `skill_dir`. The
    /// manifest bytes are written verbatim so the on-disk copy still verifies. Entry
    /// paths are already validated relative paths; a defense-in-depth check re-asserts
    /// each destination stays under `skill_dir`.
    pub fn extract_to(&self, skill_dir: &Path) -> Result<(), HpSkillError> {
        fs::create_dir_all(skill_dir)?;
        fs::write(skill_dir.join(MANIFEST_ENTRY), &self.manifest_bytes)?;
        for entry in self.assets.iter().chain(self.strings.iter()) {
            let dest = skill_dir.join(&entry.path);
            if !dest.starts_with(skill_dir) {
                return Err(HpSkillError::UnsafePath(entry.path.clone()));
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&dest, &entry.bytes)?;
        }
        Ok(())
    }
}

// ===========================================================================
// Entry sanitization (mirrors manifest.rs' rules, P1-03.4)
// ===========================================================================

/// Whether an archive entry name is a safe, package-relative path: non-empty, not
/// absolute, no `..`/`.` component, no backslash, drive-colon, or control character.
fn safe_relative_path(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_ENTRY_NAME_LEN {
        return false;
    }
    if name.starts_with('/') || name.contains('\\') || name.contains(':') || name.contains('\0') {
        return false;
    }
    name.split('/').all(|comp| {
        !comp.is_empty() && comp != "." && comp != ".." && comp.bytes().all(|b| b >= 0x20)
    })
}

/// For a `strings/<locale>.json` entry, the locale if it is a single (non-nested)
/// segment passing the manifest's [`crate::manifest::is_locale`] rule.
fn strings_locale(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(STRINGS_PREFIX)?;
    let stem = rest.strip_suffix(".json")?;
    if stem.contains('/') {
        return None; // no nesting under strings/
    }
    manifest::is_locale(stem).then_some(stem)
}

/// A conservative, fail-closed SVG content check (defense-in-depth on top of the webview
/// CSP). Rejects — rather than scrubs — any SVG that could run script, load remote/data
/// resources, or carry an inline event handler. Not a full sanitizer; a package whose SVG
/// trips any token is rejected outright.
fn svg_content_is_safe(bytes: &[u8]) -> bool {
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return false, // a binary blob wearing a .svg name
    };
    let lower = text.to_ascii_lowercase();
    if !lower.contains("<svg") {
        return false; // must actually be an SVG document
    }
    const FORBIDDEN: &[&str] = &[
        "<script", "</script", "javascript:", "<foreignobject", "<iframe", "<object",
        "<embed", "<audio", "<video", "<use", "<!entity", "<!doctype", "<![cdata[",
        "xlink:href", "data:text/html", "data:image/svg", "onload", "onerror", "onclick",
        "onmouseover", "onmouseout", "onfocus", "onbegin", "onend", "onrepeat", "onactivate",
    ];
    !FORBIDDEN.iter().any(|needle| lower.contains(needle))
}

// ===========================================================================
// Installer — wires the format into the real lifecycle + store (P1-03.2)
// ===========================================================================

/// The outcome of a successful [`SkillInstaller::install_bytes`].
#[derive(Debug, Clone, PartialEq)]
pub struct InstallOutcome {
    pub id: String,
    pub version: String,
    pub dir: PathBuf,
    pub state: LifecycleState,
}

/// The managed handle the `skill_install` / `skill_uninstall` commands drive. Owns the
/// pinned trust set, the host env used by the compatibility gate, the skills dir, the
/// in-memory [`SkillManager`] lifecycle, and a shared handle to the on-device store.
pub struct SkillInstaller {
    trusted: PackageTrustedKeys,
    env: HostEnv,
    skills_root: PathBuf,
    manager: Mutex<SkillManager>,
    store: Arc<Mutex<Store>>,
}

impl SkillInstaller {
    /// Build an installer, rehydrating the lifecycle from the persisted installed-skill
    /// registry so a returning user's installed set is known offline at launch. A row
    /// whose stored manifest no longer validates is skipped (never crashes launch).
    pub fn new(
        trusted: PackageTrustedKeys,
        env: HostEnv,
        skills_root: PathBuf,
        store: Arc<Mutex<Store>>,
    ) -> Self {
        let mut manager = SkillManager::new(env);
        if let Ok(guard) = store.lock() {
            if let Ok(rows) = guard.list_installed_skills() {
                for row in rows {
                    if let Ok((free, min_app, tier)) = governance_from_value(&row.manifest) {
                        let mut entry = SkillEntry::new(row.skill_id.clone(), free, min_app, tier);
                        entry.mark_owned(); // it was installed, so it was owned
                        entry.install_state = InstallState::Installed;
                        entry.enabled = row.enabled;
                        manager.insert(entry);
                    }
                }
            }
        }
        Self { trusted, env, skills_root, manager: Mutex::new(manager), store }
    }

    /// Build an installer whose trust set + host env come from the environment
    /// (fail-closed: an unset key env yields an empty trust set → every install rejects).
    pub fn from_env(env: HostEnv, skills_root: PathBuf, store: Arc<Mutex<Store>>) -> Self {
        let trusted = std::env::var(PACKAGE_KEYS_ENV)
            .ok()
            .and_then(|spec| parse_trusted_keys(&spec).ok())
            .unwrap_or_default();
        Self::new(trusted, env, skills_root, store)
    }

    /// Install a `.hpskill` from a filesystem path.
    pub fn install_from_path(&self, path: &Path) -> Result<InstallOutcome, HpSkillError> {
        let bytes = fs::read(path)?;
        self.install_bytes(&bytes)
    }

    /// The full install flow: verify signature → re-validate manifest → ownership +
    /// compatibility gate (before any disk write) → extract sanitized assets → register
    /// in the lifecycle → persist to the store.
    pub fn install_bytes(&self, bytes: &[u8]) -> Result<InstallOutcome, HpSkillError> {
        // 1. Verify signature + sanitize every asset (fail-closed).
        let pkg = HpSkill::open_bytes(bytes, &self.trusted)?;

        // 2. Re-validate the manifest structurally (the offline install gate, §8.2).
        let canonical = manifest::validate(&pkg.manifest).map_err(HpSkillError::Manifest)?;
        let id = canonical.id.clone();
        let version = canonical.version.clone();
        let (free, min_app, tier) = governance(&canonical)?;

        // 3. Ownership: a free skill is implicitly owned; a paid skill needs a cached
        //    entitlement (the verified license is applied upstream, §13.3).
        let mut entry = SkillEntry::new(id.clone(), free, min_app, tier);
        if free || self.is_entitled(&id) {
            entry.mark_owned();
        }
        if !entry.is_owned() {
            return Err(HpSkillError::Lifecycle(SkillError::NotOwned { id: id.clone() }));
        }

        // 4. Compatibility gate (min_app_version / min_model_tier) BEFORE touching disk.
        entry.check_compatibility(&self.env).map_err(|reason| {
            HpSkillError::Lifecycle(SkillError::Incompatible { id: id.clone(), reason })
        })?;

        // 5. Extract the sanitized assets to the skills dir.
        let dir = self.skills_root.join(&id);
        pkg.extract_to(&dir)?;

        // 6. Register in the lifecycle (re-runs the gate, then marks Installed).
        let state = {
            let mut mgr = self.manager.lock().map_err(|_| HpSkillError::Poisoned)?;
            mgr.insert(entry);
            mgr.install(&id).map_err(HpSkillError::Lifecycle)?
        };

        // 7. Persist to the store (the verified raw manifest + the extraction dir).
        {
            let store = self.store.lock().map_err(|_| HpSkillError::Poisoned)?;
            store.save_installed_skill(
                &id,
                &version,
                &pkg.manifest,
                dir.to_string_lossy().as_ref(),
                false,
            )?;
        }

        Ok(InstallOutcome { id, version, dir, state })
    }

    /// Uninstall a skill: free the disk + the store row, keep ownership (§11.3 reinstall
    /// is free). Guards the caller-supplied id against path traversal before joining it.
    pub fn uninstall(&self, skill_id: &str) -> Result<LifecycleState, HpSkillError> {
        if !manifest::is_skill_id(skill_id) {
            return Err(HpSkillError::UnsafePath(skill_id.to_string()));
        }
        let state = {
            let mut mgr = self.manager.lock().map_err(|_| HpSkillError::Poisoned)?;
            match mgr.uninstall(skill_id) {
                Ok(s) => s,
                // Not registered / not installed in memory: still clean disk + store below.
                Err(SkillError::UnknownSkill { .. }) | Err(SkillError::NotInstalled { .. }) => {
                    LifecycleState::OwnedNotInstalled
                }
                Err(e) => return Err(HpSkillError::Lifecycle(e)),
            }
        };
        let dir = self.skills_root.join(skill_id);
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        {
            let store = self.store.lock().map_err(|_| HpSkillError::Poisoned)?;
            store.remove_installed_skill(skill_id)?;
        }
        Ok(state)
    }

    /// The current lifecycle state of a registered skill.
    pub fn state(&self, id: &str) -> Result<LifecycleState, HpSkillError> {
        let mgr = self.manager.lock().map_err(|_| HpSkillError::Poisoned)?;
        mgr.state(id).map_err(HpSkillError::Lifecycle)
    }

    /// Whether a paid skill has a cached entitlement (P1-09.7 mirror). Free skills never
    /// consult this.
    fn is_entitled(&self, id: &str) -> bool {
        let Ok(store) = self.store.lock() else { return false };
        match store.load_entitlements() {
            Ok(ents) => ents.iter().any(|e| {
                e.skill_id == id && matches!(e.status.as_str(), "owned" | "active" | "entitled")
            }),
            Err(_) => false,
        }
    }
}

// ===========================================================================
// Free helpers (shared by the installer + the command layer)
// ===========================================================================

/// Extract the lifecycle-governance triple (`free`, `min_app_version`, `min_model_tier`)
/// from a validated canonical manifest, reading the CANONICAL field locations
/// (`pricing.free`, top-level `min_app_version`, `requirements.min_model_tier`).
fn governance(c: &CanonicalManifest) -> Result<(bool, SemVer, ModelTier), HpSkillError> {
    let min_app = c.min_app_version.parse::<SemVer>().map_err(HpSkillError::BadVersion)?;
    let tier = c.requirements.min_model_tier.parse::<ModelTier>().map_err(HpSkillError::BadTier)?;
    Ok((c.pricing.free, min_app, tier))
}

/// Validate a raw manifest and pull its governance triple — used to rehydrate the
/// lifecycle from a persisted install.
fn governance_from_value(v: &Value) -> Result<(bool, SemVer, ModelTier), HpSkillError> {
    let canonical = manifest::validate(v).map_err(HpSkillError::Manifest)?;
    governance(&canonical)
}

/// Parse a `kid=spkiB64` env spec (entries separated by `;` or `,`) into a trust set.
pub fn parse_trusted_keys(spec: &str) -> Result<PackageTrustedKeys, PackageVerifyError> {
    let mut set = PackageTrustedKeys::new();
    for entry in spec.split([';', ',']).map(str::trim).filter(|e| !e.is_empty()) {
        let (kid, b64) = entry.split_once('=').ok_or(PackageVerifyError::BadPublicKey)?;
        set.insert_spki_b64(kid.trim(), b64.trim())?;
    }
    Ok(set)
}

/// The host environment for the compatibility gate, resolved from the environment
/// (app version + model tier), falling back to `CARGO_PKG_VERSION` / `Small`.
pub fn host_env_from_env() -> HostEnv {
    let app_version = std::env::var(APP_VERSION_ENV)
        .ok()
        .and_then(|v| v.parse::<SemVer>().ok())
        .unwrap_or_else(|| {
            env!("CARGO_PKG_VERSION").parse::<SemVer>().unwrap_or(SemVer::new(0, 0, 0))
        });
    let model_tier = std::env::var(MODEL_TIER_ENV)
        .ok()
        .and_then(|v| v.parse::<ModelTier>().ok())
        .unwrap_or_default();
    HostEnv::new(app_version, model_tier)
}

/// A stable snake_case label for a lifecycle state (the `state` field on the IPC result).
pub fn state_label(state: LifecycleState) -> &'static str {
    match state {
        LifecycleState::NotOwned => "not_owned",
        LifecycleState::OwnedNotInstalled => "owned_not_installed",
        LifecycleState::InstalledDisabled => "installed_disabled",
        LifecycleState::EnabledActive => "enabled_active",
    }
}

// ===========================================================================
// Tests — pure, in-memory. Zip a package around the golden vector + self-signed
// full manifests; assert the accept/reject matrix and the full install flow.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::skill_manager::Incompatibility;

    /// The fixed 12-byte Ed25519 X.509 SPKI DER prefix (identical to `package_verify`'s),
    /// used to wrap a test verifying key back into the base64 SPKI the trust set ingests.
    const ED25519_SPKI_PREFIX: [u8; 12] =
        [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

    fn spki_b64(vk: &VerifyingKey) -> String {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(vk.as_bytes());
        STANDARD.encode(der)
    }

    fn trusted_with(kid: &str, vk: &VerifyingKey) -> PackageTrustedKeys {
        let mut t = PackageTrustedKeys::new();
        t.insert_spki_b64(kid, &spki_b64(vk)).unwrap();
        t
    }

    /// Sign `manifest` in place exactly as the backend `PackageSigner` does: Ed25519 over
    /// the RFC 8785 JCS canonicalization of the manifest with the two signature fields
    /// removed, injected back as `signature` (`ed25519:<base64>`) + `signing_key_id`.
    fn sign_into(manifest: &mut Value, sk: &SigningKey, kid: &str) {
        let canonical = package_verify::canonical_bytes(manifest);
        let sig = sk.sign(&canonical);
        let wire = format!("ed25519:{}", STANDARD.encode(sig.to_bytes()));
        let obj = manifest.as_object_mut().unwrap();
        obj.insert("signature".to_string(), Value::String(wire));
        obj.insert("signing_key_id".to_string(), Value::String(kid.to_string()));
    }

    /// A structurally-complete manifest that passes `manifest::validate()` — for the full
    /// install-flow tests. `free`/`min_app_version` are configurable; signed separately.
    fn full_manifest(id: &str, min_app_version: &str, free: bool) -> Value {
        let pricing = if free {
            json!({ "free": true })
        } else {
            json!({ "free": false, "price": { "amount_minor": 500, "currency": "USD" } })
        };
        json!({
            "manifest_version": "1.0",
            "id": id,
            "name": "Test Skill",
            "version": "1.0.0",
            "category": "Other",
            "min_app_version": min_app_version,
            "requirements": { "min_model_tier": "small" },
            "pricing": pricing,
            "persona": { "system_prompt": "You help with tests.", "compressed_prompt": "Test helper." }
        })
    }

    fn to_vec(v: &Value) -> Vec<u8> {
        serde_json::to_vec(v).unwrap()
    }

    /// Build an in-memory `.hpskill` zip from `(name, bytes)` entries.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write as _;
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        {
            let mut zw = zip::ZipWriter::new(&mut cursor);
            for (name, data) in entries {
                let opts = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                zw.start_file(name.to_string(), opts).expect("start_file");
                zw.write_all(data).expect("write entry");
            }
            zw.finish().expect("finish zip");
        }
        cursor.into_inner()
    }

    // --- golden vector (the cross-language signature proof) -----------------

    #[derive(serde::Deserialize)]
    struct Golden {
        manifest: Value,
        package_public_key_b64: String,
        kid: String,
    }

    fn golden() -> Golden {
        let raw = include_str!("../../../contracts/testdata/package-signing-golden.json");
        serde_json::from_str(raw).expect("golden vector parses")
    }

    fn golden_trusted(g: &Golden) -> PackageTrustedKeys {
        let mut t = PackageTrustedKeys::new();
        t.insert_spki_b64(g.kid.clone(), &g.package_public_key_b64).unwrap();
        t
    }

    /// THE acceptance case: a `.hpskill` zipped around the golden manifest + its detached
    /// signature opens and verifies against the golden key — proving the package
    /// signature format matches the backend PackageSigner byte-for-byte.
    #[test]
    fn open_accepts_the_golden_vector_package() {
        let g = golden();
        let trusted = golden_trusted(&g);
        let zip = build_zip(&[("manifest.json", &to_vec(&g.manifest))]);

        let pkg = HpSkill::open_bytes(&zip, &trusted).expect("golden .hpskill verifies + opens");
        assert_eq!(pkg.manifest, g.manifest, "the opened manifest round-trips the golden bytes");
        assert!(pkg.assets.is_empty());
        assert!(pkg.strings.is_empty());
    }

    #[test]
    fn tampered_manifest_is_rejected_as_signature_mismatch() {
        let g = golden();
        let trusted = golden_trusted(&g);
        let mut tampered = g.manifest.clone();
        tampered["name"] = Value::String("Golden Vector — TAMPERED".to_string());
        let zip = build_zip(&[("manifest.json", &to_vec(&tampered))]);

        let err = HpSkill::open_bytes(&zip, &trusted).unwrap_err();
        assert!(
            matches!(err, HpSkillError::Verify(PackageVerifyError::SignatureMismatch)),
            "got {err:?}"
        );
    }

    #[test]
    fn missing_or_wrong_signature_is_rejected() {
        let g = golden();
        let trusted = golden_trusted(&g);

        // Signature field removed entirely -> MissingSignature.
        let mut no_sig = g.manifest.clone();
        no_sig.as_object_mut().unwrap().remove("signature");
        let zip = build_zip(&[("manifest.json", &to_vec(&no_sig))]);
        assert!(matches!(
            HpSkill::open_bytes(&zip, &trusted).unwrap_err(),
            HpSkillError::Verify(PackageVerifyError::MissingSignature)
        ));

        // A well-formed but wrong 64-byte signature -> SignatureMismatch.
        let mut wrong = g.manifest.clone();
        wrong["signature"] = Value::String(format!("ed25519:{}", STANDARD.encode([0u8; 64])));
        let zip = build_zip(&[("manifest.json", &to_vec(&wrong))]);
        assert!(matches!(
            HpSkill::open_bytes(&zip, &trusted).unwrap_err(),
            HpSkillError::Verify(PackageVerifyError::SignatureMismatch)
        ));
    }

    #[test]
    fn unknown_kid_is_rejected() {
        let g = golden();
        let empty = PackageTrustedKeys::new(); // the golden kid is not trusted
        let zip = build_zip(&[("manifest.json", &to_vec(&g.manifest))]);
        assert!(matches!(
            HpSkill::open_bytes(&zip, &empty).unwrap_err(),
            HpSkillError::Verify(PackageVerifyError::UnknownKid)
        ));
    }

    #[test]
    fn missing_manifest_entry_is_rejected() {
        // A well-formed svg asset but no manifest.json.
        let zip = build_zip(&[("assets/logo.svg", b"<svg></svg>")]);
        let trusted = PackageTrustedKeys::new();
        assert!(matches!(
            HpSkill::open_bytes(&zip, &trusted).unwrap_err(),
            HpSkillError::MissingManifest
        ));
    }

    #[test]
    fn path_traversal_asset_entry_is_rejected() {
        let g = golden();
        let trusted = golden_trusted(&g);
        // A traversal entry alongside an otherwise-valid signed manifest — caught during
        // the archive walk, before the signature is even checked.
        let zip = build_zip(&[
            ("manifest.json", &to_vec(&g.manifest)),
            ("assets/../evil.svg", b"<svg></svg>"),
        ]);
        let err = HpSkill::open_bytes(&zip, &trusted).unwrap_err();
        assert!(matches!(err, HpSkillError::UnsafePath(_)), "got {err:?}");
    }

    #[test]
    fn non_svg_non_json_entry_is_rejected() {
        let g = golden();
        let trusted = golden_trusted(&g);
        let zip = build_zip(&[
            ("manifest.json", &to_vec(&g.manifest)),
            ("assets/logo.png", b"\x89PNG\r\n"),
        ]);
        assert!(matches!(
            HpSkill::open_bytes(&zip, &trusted).unwrap_err(),
            HpSkillError::UnexpectedEntry(_)
        ));
    }

    #[test]
    fn svg_with_script_is_rejected_by_content_sanitize() {
        let sk = SigningKey::from_bytes(&[5u8; 32]);
        let mut m = full_manifest("evil-svg-skill", "1.0.0", true);
        sign_into(&mut m, &sk, "pkg-key");
        let trusted = trusted_with("pkg-key", &sk.verifying_key());
        let zip = build_zip(&[
            ("manifest.json", &to_vec(&m)),
            ("assets/logo.svg", b"<svg><script>alert(1)</script></svg>"),
        ]);
        assert!(matches!(
            HpSkill::open_bytes(&zip, &trusted).unwrap_err(),
            HpSkillError::UnsafeSvg(_)
        ));
    }

    // --- full install flow --------------------------------------------------

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_skills_root(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("hydropark-hpskill-{}-{}-{}", std::process::id(), tag, n));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn in_memory_store() -> Arc<Mutex<Store>> {
        Arc::new(Mutex::new(Store::open_in_memory().unwrap()))
    }

    #[test]
    fn full_install_flow_extracts_registers_persists_then_uninstalls() {
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let mut m = full_manifest("timer-skill", "1.0.0", true);
        sign_into(&mut m, &sk, "pkg-key");
        let trusted = trusted_with("pkg-key", &sk.verifying_key());
        let zip = build_zip(&[
            ("manifest.json", &to_vec(&m)),
            ("assets/logo.svg", b"<svg></svg>"),
            ("strings/en.json", br#"{"title":"Timer"}"#),
        ]);

        let root = temp_skills_root("happy");
        let store = in_memory_store();
        let env = HostEnv::new("1.5.0".parse().unwrap(), ModelTier::Small);
        let installer = SkillInstaller::new(trusted, env, root.clone(), store.clone());

        let outcome = installer.install_bytes(&zip).expect("install succeeds");
        assert_eq!(outcome.id, "timer-skill");
        assert_eq!(outcome.version, "1.0.0");
        assert_eq!(outcome.state, LifecycleState::InstalledDisabled);

        // Extracted to disk: manifest + sanitized asset + strings.
        assert!(root.join("timer-skill/manifest.json").exists());
        assert!(root.join("timer-skill/assets/logo.svg").exists());
        assert!(root.join("timer-skill/strings/en.json").exists());

        // Registered in the lifecycle + persisted in the store.
        assert_eq!(installer.state("timer-skill").unwrap(), LifecycleState::InstalledDisabled);
        assert!(store.lock().unwrap().load_installed_skill("timer-skill").unwrap().is_some());

        // A fresh installer over the same store rehydrates the installed set (no trust
        // needed — nothing is re-verified on rehydrate).
        let installer2 =
            SkillInstaller::new(PackageTrustedKeys::new(), env, root.clone(), store.clone());
        assert_eq!(installer2.state("timer-skill").unwrap(), LifecycleState::InstalledDisabled);

        // Uninstall frees the disk + the store row, keeps ownership.
        let state = installer.uninstall("timer-skill").expect("uninstall succeeds");
        assert_eq!(state, LifecycleState::OwnedNotInstalled);
        assert!(!root.join("timer-skill").exists());
        assert!(store.lock().unwrap().load_installed_skill("timer-skill").unwrap().is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_is_blocked_by_incompatible_min_app_version_and_writes_nothing() {
        let sk = SigningKey::from_bytes(&[4u8; 32]);
        let mut m = full_manifest("too-new-skill", "2.0.0", true);
        sign_into(&mut m, &sk, "pkg-key");
        let trusted = trusted_with("pkg-key", &sk.verifying_key());
        let zip = build_zip(&[("manifest.json", &to_vec(&m))]);

        let root = temp_skills_root("incompat");
        let store = in_memory_store();
        // Host app is older than the skill's min_app_version -> the gate blocks install.
        let env = HostEnv::new("1.0.0".parse().unwrap(), ModelTier::Small);
        let installer = SkillInstaller::new(trusted, env, root.clone(), store.clone());

        let err = installer.install_bytes(&zip).unwrap_err();
        match err {
            HpSkillError::Lifecycle(SkillError::Incompatible { ref id, ref reason }) => {
                assert_eq!(id.as_str(), "too-new-skill");
                assert!(matches!(reason, Incompatibility::TooNewForApp { .. }), "got {reason:?}");
            }
            other => panic!("expected TooNewForApp incompatibility, got {other:?}"),
        }

        // Fail-closed: nothing extracted, nothing persisted.
        assert!(!root.join("too-new-skill").exists());
        assert!(store.lock().unwrap().load_installed_skill("too-new-skill").unwrap().is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_is_blocked_by_unknown_kid_and_writes_nothing() {
        let sk = SigningKey::from_bytes(&[6u8; 32]);
        let mut m = full_manifest("orphan-skill", "1.0.0", true);
        sign_into(&mut m, &sk, "pkg-key");
        let trusted = PackageTrustedKeys::new(); // does NOT trust "pkg-key"
        let zip = build_zip(&[("manifest.json", &to_vec(&m))]);

        let root = temp_skills_root("nokid");
        let store = in_memory_store();
        let env = HostEnv::new("1.5.0".parse().unwrap(), ModelTier::Small);
        let installer = SkillInstaller::new(trusted, env, root.clone(), store.clone());

        assert!(matches!(
            installer.install_bytes(&zip).unwrap_err(),
            HpSkillError::Verify(PackageVerifyError::UnknownKid)
        ));
        assert!(!root.join("orphan-skill").exists());
        assert!(store.lock().unwrap().load_installed_skill("orphan-skill").unwrap().is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_trusted_keys_reads_kid_equals_spki_pairs() {
        let sk = SigningKey::from_bytes(&[8u8; 32]);
        let spec = format!("pkg-key={}", spki_b64(&sk.verifying_key()));
        let trusted = parse_trusted_keys(&spec).expect("spec parses");
        assert_eq!(trusted.len(), 1);
        assert!(trusted.get("pkg-key").is_some());
        // An empty spec yields an empty (fail-closed) set.
        assert!(parse_trusted_keys("").unwrap().is_empty());
    }
}
