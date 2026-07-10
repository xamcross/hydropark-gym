//! Deterministic, **non-model** allergen-warning layer (P0-07.4, SPEC §28.1).
//!
//! SAFETY-CRITICAL and NEVER model-trusted. This runs a rule-based scan over
//! the *ingredient text* (the `list_manage` `ingredients` slot and any recipe
//! text) and flags the Big-9 allergens. The product does **not** rely on the
//! model for allergen safety — PHASE0-PLAN §4b grades the model and this layer
//! *separately*, and the H2 exit floor requires this layer to fire on **100%**
//! of known-allergen prompts.
//!
//! The allergen -> trigger-term map is NOT hardcoded here — it lives in the
//! single canonical data file `allergens.json` next to this module and is
//! embedded at compile time via `include_str!`. The exact same file is read by
//! the H2 eval harness (`eval/allergen.py`), so the shipped app and the harness
//! provably scan against identical data (no drift, no duplicated map).
//!
//! Matching is **whole-word, case-insensitive** using a std-only boundary check
//! (no `regex` dependency — this crate's `Cargo.toml` is being edited elsewhere
//! for the llama.cpp work, so this module stays dependency-free on purpose).
//! Whole-word matching is why `"egg"` does not fire on `"eggplant"` and `"fish"`
//! does not fire on `"shellfish"`.
//!
//! The layer optimises **recall over precision** by design (see allergens.json):
//! over-warning is a nuisance, a missed allergen is a safety failure.
//!
//! NOTE: like the rest of this crate, this module is *authored, not compiled* in
//! the current environment (no `cargo` here — see client/README.md and
//! Cargo.toml). The runnable 100%-coverage proof over the same `allergens.json`
//! is `eval/test_allergen.py`; the `#[cfg(test)]` block below is its mirror, to
//! run once a Rust toolchain is available.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// One allergen's canonical display name + its trigger terms.
#[derive(Debug, Deserialize)]
pub struct AllergenEntry {
    pub display: String,
    pub terms: Vec<String>,
}

/// Deserialized shape of `allergens.json`.
#[derive(Debug, Deserialize)]
pub struct AllergenDb {
    pub version: u32,
    pub big9: Vec<String>,
    pub allergens: BTreeMap<String, AllergenEntry>,
}

/// A single allergen hit produced by [`scan`]. Serializable so it can cross the
/// Tauri IPC boundary as the result of the `allergen_scan` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AllergenFlag {
    /// Canonical allergen key, e.g. `"tree_nuts"`.
    pub allergen: String,
    /// Human-facing label, e.g. `"Tree nuts"`.
    pub display: String,
    /// The lowercased trigger term that matched, e.g. `"marzipan"`.
    pub matched_term: String,
}

const RAW_DB: &str = include_str!("allergens.json");

fn db() -> &'static AllergenDb {
    static DB: OnceLock<AllergenDb> = OnceLock::new();
    DB.get_or_init(|| {
        serde_json::from_str(RAW_DB).expect("allergens.json is malformed — safety layer cannot load")
    })
}

/// The canonical allergen database (Big-9 keys + trigger terms). Cheap after
/// first call (parsed once, cached).
pub fn database() -> &'static AllergenDb {
    db()
}

/// True iff `bytes[i]` is an ASCII word character (letter or digit). The
/// boundary rule below treats everything else — spaces, commas, hyphens,
/// parentheses, apostrophes, digits-vs-letters transitions are NOT split — as a
/// boundary. Mirrors the same predicate in `eval/allergen.py` exactly.
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric()
}

/// Whole-word, case-insensitive substring search. Returns true iff `needle`
/// occurs in `haystack` bounded on both sides by a non-word char (or string
/// edge). Both inputs must already be lowercased. `needle` may contain spaces
/// (multi-word terms like `"soy sauce"`).
fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let hay = haystack.as_bytes();
    let ndl = needle.as_bytes();
    let mut start = 0;
    while let Some(rel) = haystack[start..].find(needle) {
        let i = start + rel;
        let j = i + ndl.len();
        let left_ok = i == 0 || !is_word_byte(hay[i - 1]);
        let right_ok = j == hay.len() || !is_word_byte(hay[j]);
        if left_ok && right_ok {
            return true;
        }
        start = i + 1; // overlap-safe advance
    }
    false
}

/// Scan arbitrary ingredient/recipe text and return every Big-9 allergen it
/// triggers. Deterministic, order-stable (allergens in `big9` order, then the
/// first matching term). NEVER consults the model.
pub fn scan(text: &str) -> Vec<AllergenFlag> {
    let lower = text.to_lowercase();
    let database = db();
    let mut flags = Vec::new();
    for key in &database.big9 {
        let Some(entry) = database.allergens.get(key) else {
            continue;
        };
        if let Some(term) = entry
            .terms
            .iter()
            .find(|t| contains_word(&lower, &t.to_lowercase()))
        {
            flags.push(AllergenFlag {
                allergen: key.clone(),
                display: entry.display.clone(),
                matched_term: term.to_lowercase(),
            });
        }
    }
    flags
}

/// Convenience for callers (and the harness's full-system pass) that only need
/// the set of allergen keys present in a list of ingredient names.
pub fn scan_ingredients<I, S>(ingredient_names: I) -> Vec<AllergenFlag>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let joined = ingredient_names
        .into_iter()
        .map(|s| s.as_ref().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    scan(&joined)
}

// ---------------------------------------------------------------------------
// 100%-coverage test (P0-07.4 AC). Mirror of eval/test_allergen.py — the
// runnable proof lives there because there is no `cargo` in this environment.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// EXHAUSTIVE: for every allergen in the map, and every trigger term of
    /// that allergen, assert the layer flags that allergen. This is the literal
    /// "100%-coverage test" P0-07.4 asks for.
    #[test]
    fn every_allergen_and_every_term_is_flagged() {
        let database = db();
        let mut checked = 0usize;
        for (key, entry) in &database.allergens {
            for term in &entry.terms {
                // Embed the term in realistic ingredient-line context so the
                // whole-word boundaries are genuinely exercised.
                let text = format!("2 cups of {term}, finely chopped");
                let flags = scan(&text);
                assert!(
                    flags.iter().any(|f| &f.allergen == key),
                    "allergen '{key}' NOT flagged for its own trigger term '{term}' (input: {text:?})"
                );
                checked += 1;
            }
        }
        assert!(checked > 0, "no terms were checked — data failed to load");
        eprintln!("allergen coverage: {checked} (allergen, term) pairs, all flagged");
    }

    #[test]
    fn required_hidden_aliases_resolve() {
        assert!(scan("sodium caseinate").iter().any(|f| f.allergen == "milk"));
        assert!(scan("dried albumin powder").iter().any(|f| f.allergen == "eggs"));
        assert!(scan("a spoon of tahini").iter().any(|f| f.allergen == "sesame"));
        assert!(scan("marzipan filling").iter().any(|f| f.allergen == "tree_nuts"));
        assert!(scan("worcestershire sauce").iter().any(|f| f.allergen == "fish"));
    }

    #[test]
    fn whole_word_avoids_classic_false_matches() {
        // "eggplant" must NOT flag eggs; "shellfish" must NOT flag fish.
        assert!(!scan("grilled eggplant").iter().any(|f| f.allergen == "eggs"));
        assert!(!scan("steamed shellfish").iter().any(|f| f.allergen == "fish"));
    }

    #[test]
    fn clean_text_flags_nothing() {
        assert!(scan("rice, water, salt, black pepper, olive oil").is_empty());
    }
}
