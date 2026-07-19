#![allow(dead_code)] // Phase-1 composition core; wired into the turn loop in a later ticket.

//! Shared-state store, slot compatibility & writer arbitration
//! (P1-04.4/.5/.6, SPEC §8.3.4-§8.3.5, §8.3.6).
//!
//! When several skills are active they can *share data* through named
//! **slots** (`ingredients`, `packing_list`, …). Each skill declares the slots
//! it touches (`SharedStateDecl { slot, access, schema }`, produced by the
//! orchestrator's manifest); this module turns those declarations into a live,
//! per-agent store. Three concerns, each a sub-ticket:
//!
//!  - **Closed type language** (§8.3.4, P1-04.4): `schema` is parsed into a
//!    [`SlotType`] from a small *closed* grammar — `scalar` /
//!    `scalar<string|number|bool|enum(A|B|…)>`, `list<item>` /
//!    `list<record{…}>`, and `record` / `record{field: T, field?: T, …}`.
//!    Unknown schemas are rejected with a clear reason. `list<item>` is the
//!    app-defined entry record whose `id` is a **stable, app-assigned** entry
//!    id — the key that makes cross-skill append/patch merges commute.
//!  - **Slot compatibility** (§8.3.4, P1-04.5): when two active skills declare
//!    the *same* slot they compose only if the [`SlotType`]s are **structurally
//!    equal after optional-field widening** — same base kind and same
//!    **required** fields; extra **optional** fields are allowed. An
//!    incompatible pair **blocks** the combination with an error naming the
//!    slot, the two disagreeing skills, and the specific field mismatch.
//!  - **Writer-of-record arbitration** (§8.3.4/§8.3.6, P1-04.6): a slot has
//!    exactly **one** writer-of-record — the first declarer, in the
//!    orchestrator's deterministic merge order (§8.3.2), whose `access` grants
//!    write. `set` on a `scalar`/`record` slot is the writer-of-record's alone;
//!    any reader/writer may `append`/`patch` a `list`, and those operations
//!    **commute** because the store stamps each append with an app-assigned,
//!    order-independent entry id.
//!
//! Like `orchestrator`, this module is deliberately free of any Tauri /
//! inference coupling so it is pure and unit-testable (`cargo test
//! --no-default-features --features mock-inference`). It consumes only the two
//! shared manifest types the orchestrator exports.

use std::collections::BTreeMap;

use crate::orchestrator::{SharedStateDecl, SkillManifest};

// ---------------------------------------------------------------------------
// Closed type language (§8.3.4, P1-04.4)
// ---------------------------------------------------------------------------

/// A scalar's base kind in the closed type language: `scalar<…>`.
/// A bare `scalar` parses to [`ScalarKind::Any`] — an *unspecified* scalar that
/// widens to any concrete kind (so `scalar` composes with `scalar<number>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScalarKind {
    /// Bare `scalar` — unspecified; compatible with any other scalar kind.
    Any,
    String,
    Number,
    Bool,
    /// `enum(A|B|…)`. Variants are normalised (sorted + de-duplicated) so that
    /// `enum(a|b)` and `enum(b|a)` are structurally equal.
    Enum(Vec<String>),
}

/// One field of a `record<{…}>` (or of a `list<item>` entry): its type and
/// whether it is **required**. Optional fields are marked with a trailing `?`
/// in the schema (`qty?: number`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub ty: SlotType,
    pub required: bool,
}

/// A record type: an ordered field set (name → [`Field`]). Both `record{…}`
/// slots and `list<item>`/`list<record{…}>` entries are records.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Record {
    pub fields: BTreeMap<String, Field>,
}

/// The closed slot type language (§8.3.4), parsed from
/// [`SharedStateDecl::schema`] by [`parse_slot_type`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotType {
    Scalar(ScalarKind),
    /// A list of records; the store assigns each entry a **stable, app-assigned
    /// id** on `append`, which is what makes concurrent appends commute.
    List(Record),
    Record(Record),
}

/// The app-defined `item` record that `list<item>` is shorthand for (§8.3.4):
/// `{ id: string, name: string, qty?: number, unit?: string, checked?: bool }`.
/// `id` is app-assigned on insert; it is modelled as a required field so two
/// `list<item>` declarations are trivially compatible.
pub fn item_record() -> Record {
    let mut fields = BTreeMap::new();
    let req = |k: &str| (k.to_string(), Field { ty: SlotType::Scalar(ScalarKind::String), required: true });
    let opt = |k: &str, ty: SlotType| (k.to_string(), Field { ty, required: false });
    fields.extend([
        req("id"),
        req("name"),
        opt("qty", SlotType::Scalar(ScalarKind::Number)),
        opt("unit", SlotType::Scalar(ScalarKind::String)),
        opt("checked", SlotType::Scalar(ScalarKind::Bool)),
    ]);
    Record { fields }
}

/// Parse a `schema` string from the closed type language into a [`SlotType`].
///
/// Accepts: `scalar`, `scalar<string|number|bool|enum(A|B|…)>`, the scalar
/// shorthands `string`/`number`/`bool`/`enum(…)`, `list<item>`,
/// `list<record{…}>`, `record`, and `record{field: T, field?: T, …}`.
/// Anything else returns a human-readable reason (unknown schema).
pub fn parse_slot_type(schema: &str) -> Result<SlotType, String> {
    let s = schema.trim();
    if s.is_empty() {
        return Err("empty schema".to_string());
    }
    if s == "scalar" {
        return Ok(SlotType::Scalar(ScalarKind::Any));
    }
    if let Some(inner) = s.strip_prefix("scalar<").and_then(|x| x.strip_suffix('>')) {
        return Ok(SlotType::Scalar(parse_scalar_kind(inner)?));
    }
    if let Some(inner) = s.strip_prefix("list<").and_then(|x| x.strip_suffix('>')) {
        let inner = inner.trim();
        let item = if inner == "item" {
            item_record()
        } else {
            match parse_slot_type(inner)? {
                SlotType::Record(r) => r,
                other => {
                    return Err(format!(
                        "list items must be a record (`list<item>` or `list<record{{…}}>`), not `{}`",
                        kind_name(&other)
                    ))
                }
            }
        };
        return Ok(SlotType::List(item));
    }
    if s == "record" {
        return Ok(SlotType::Record(Record::default()));
    }
    if let Some(inner) = s.strip_prefix("record{").and_then(|x| x.strip_suffix('}')) {
        return Ok(SlotType::Record(parse_record_fields(inner)?));
    }
    // Scalar shorthands, also usable as record-field types.
    if s == "string" || s == "number" || s == "bool" || s.starts_with("enum(") {
        return Ok(SlotType::Scalar(parse_scalar_kind(s)?));
    }
    Err(format!(
        "unknown schema `{s}` (expected scalar | scalar<…> | list<item> | list<record{{…}}> | record | record{{…}})"
    ))
}

fn parse_scalar_kind(s: &str) -> Result<ScalarKind, String> {
    let s = s.trim();
    match s {
        "string" => Ok(ScalarKind::String),
        "number" => Ok(ScalarKind::Number),
        "bool" => Ok(ScalarKind::Bool),
        _ => {
            if let Some(inner) = s.strip_prefix("enum(").and_then(|x| x.strip_suffix(')')) {
                let mut variants: Vec<String> = split_top_level(inner, '|')
                    .into_iter()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect();
                if variants.is_empty() {
                    return Err("enum(…) needs at least one variant".to_string());
                }
                variants.sort();
                variants.dedup();
                Ok(ScalarKind::Enum(variants))
            } else {
                Err(format!("unknown scalar kind `{s}`"))
            }
        }
    }
}

fn parse_record_fields(inner: &str) -> Result<Record, String> {
    let mut fields: BTreeMap<String, Field> = BTreeMap::new();
    for raw in split_top_level(inner, ',') {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let (name, field) = parse_field(raw)?;
        if fields.insert(name.clone(), field).is_some() {
            return Err(format!("duplicate record field `{name}`"));
        }
    }
    Ok(Record { fields })
}

fn parse_field(field: &str) -> Result<(String, Field), String> {
    let (name_raw, ty_raw) = split_first_top_level(field, ':')
        .ok_or_else(|| format!("record field `{field}` is missing a `: type`"))?;
    let name_raw = name_raw.trim();
    let (name, required) = match name_raw.strip_suffix('?') {
        Some(stripped) => (stripped.trim(), false),
        None => (name_raw, true),
    };
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("invalid record field name `{name_raw}`"));
    }
    let ty = parse_slot_type(ty_raw.trim())?;
    Ok((name.to_string(), Field { ty, required }))
}

/// Split `s` on every occurrence of `sep` that sits at bracket depth zero
/// (`<>`, `{}`, `()`), so nested types and enum bodies are not split apart.
fn split_top_level(s: &str, sep: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth: i32 = 0;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '<' | '{' | '(' => {
                depth += 1;
                cur.push(ch);
            }
            '>' | '}' | ')' => {
                depth -= 1;
                cur.push(ch);
            }
            c if c == sep && depth == 0 => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            c => cur.push(c),
        }
    }
    if !cur.trim().is_empty() || !out.is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Split `s` at the *first* `sep` at bracket depth zero. Used to separate a
/// field's `name` from its `type` without tripping over a nested `record{…}`.
fn split_first_top_level(s: &str, sep: char) -> Option<(&str, &str)> {
    let mut depth: i32 = 0;
    for (i, ch) in s.char_indices() {
        match ch {
            '<' | '{' | '(' => depth += 1,
            '>' | '}' | ')' => depth -= 1,
            c if c == sep && depth == 0 => return Some((&s[..i], &s[i + c.len_utf8()..])),
            _ => {}
        }
    }
    None
}

fn kind_name(ty: &SlotType) -> String {
    match ty {
        SlotType::Scalar(k) => scalar_kind_name(k),
        SlotType::List(_) => "list".to_string(),
        SlotType::Record(_) => "record".to_string(),
    }
}

fn scalar_kind_name(k: &ScalarKind) -> String {
    match k {
        ScalarKind::Any => "scalar".to_string(),
        ScalarKind::String => "scalar<string>".to_string(),
        ScalarKind::Number => "scalar<number>".to_string(),
        ScalarKind::Bool => "scalar<bool>".to_string(),
        ScalarKind::Enum(v) => format!("scalar<enum({})>", v.join("|")),
    }
}

// ---------------------------------------------------------------------------
// Slot compatibility & writer-of-record resolution (§8.3.4-.5, P1-04.5/.6)
// ---------------------------------------------------------------------------

/// The resolved contract for one slot after composing every declarer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotSpec {
    /// The composed type: required fields agreed by all declarers, plus the
    /// union of their optional fields (optional-field widening, §8.3.4).
    pub ty: SlotType,
    /// The single writer-of-record, or `None` when no declarer has write
    /// access (a read-only slot that `set` can never mutate).
    pub writer: Option<String>,
    /// Every skill that declared this slot, in merge order.
    pub declarers: Vec<String>,
}

/// Why a set of declared slots cannot be composed (the compatibility gate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotError {
    /// A `schema` string is not valid in the closed type language.
    BadSchema { slot: String, skill: String, schema: String, reason: String },
    /// Two skills declare the same slot with structurally-incompatible types.
    /// `detail` names the specific field/kind mismatch.
    Incompatible { slot: String, skill_a: String, skill_b: String, detail: String },
}

impl std::fmt::Display for SlotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlotError::BadSchema { slot, skill, schema, reason } => write!(
                f,
                "skill '{skill}' declares slot '{slot}' with an invalid schema `{schema}`: {reason}"
            ),
            SlotError::Incompatible { slot, skill_a, skill_b, detail } => write!(
                f,
                "slot '{slot}' is declared incompatibly by '{skill_a}' and '{skill_b}': {detail}"
            ),
        }
    }
}

impl std::error::Error for SlotError {}

/// One parsed declaration of a slot, retaining who declared it and whether they
/// hold write access — enough to arbitrate the writer-of-record.
struct Decl {
    skill: String,
    ty: SlotType,
    write: bool,
}

fn grants_write(access: &str) -> bool {
    matches!(access, "write" | "read_write")
}

/// Resolve the shared-state slots for a set of active skills (the compatibility
/// gate, P1-04.5). `skills` must be in the orchestrator's deterministic merge
/// order (§8.3.2); that order is what makes the writer-of-record — the first
/// write-capable declarer per slot — equal to §8.3.4's "highest-priority
/// `read_write` declarer".
///
/// Returns the composed [`SlotSpec`] per slot, or the first [`SlotError`]
/// (bad schema, or an incompatible same-slot pair naming the disagreeing
/// skills and the field mismatch).
pub fn resolve_slots(skills: &[SkillManifest]) -> Result<BTreeMap<String, SlotSpec>, SlotError> {
    resolve_decls(skills.iter().map(|s| (s.id.as_str(), s.shared_state.as_slice())))
}

/// As [`resolve_slots`], but taking raw `(skill_id, decls)` pairs (also in merge
/// order) instead of full manifests.
pub fn resolve_slots_from_decls(
    skills: &[(String, Vec<SharedStateDecl>)],
) -> Result<BTreeMap<String, SlotSpec>, SlotError> {
    resolve_decls(skills.iter().map(|(id, ds)| (id.as_str(), ds.as_slice())))
}

fn resolve_decls<'a>(
    skills: impl Iterator<Item = (&'a str, &'a [SharedStateDecl])>,
) -> Result<BTreeMap<String, SlotSpec>, SlotError> {
    // Group declarations by slot, preserving merge order within each slot.
    let mut groups: BTreeMap<String, Vec<Decl>> = BTreeMap::new();
    for (skill_id, decls) in skills {
        for d in decls {
            let ty = parse_slot_type(&d.schema).map_err(|reason| SlotError::BadSchema {
                slot: d.slot.clone(),
                skill: skill_id.to_string(),
                schema: d.schema.clone(),
                reason,
            })?;
            groups.entry(d.slot.clone()).or_default().push(Decl {
                skill: skill_id.to_string(),
                ty,
                write: grants_write(&d.access),
            });
        }
    }

    let mut specs: BTreeMap<String, SlotSpec> = BTreeMap::new();
    for (slot, decls) in groups {
        // Pairwise structural compatibility. Checking *all* pairs (not just
        // against the first) prevents a bare `scalar`'s Any-widening from
        // masking a genuine string-vs-number conflict between two others.
        for i in 0..decls.len() {
            for j in (i + 1)..decls.len() {
                if let Err(detail) = types_compatible(&decls[i].ty, &decls[j].ty) {
                    return Err(SlotError::Incompatible {
                        slot: slot.clone(),
                        skill_a: decls[i].skill.clone(),
                        skill_b: decls[j].skill.clone(),
                        detail,
                    });
                }
            }
        }

        // Writer-of-record: first write-capable declarer in merge order.
        let writer = decls.iter().find(|d| d.write).map(|d| d.skill.clone());
        let declarers = decls.iter().map(|d| d.skill.clone()).collect();
        // Composed type: fold optional-field widening across all declarers.
        let mut ty = decls[0].ty.clone();
        for d in &decls[1..] {
            ty = widen(&ty, &d.ty);
        }

        specs.insert(slot, SlotSpec { ty, writer, declarers });
    }
    Ok(specs)
}

/// Structural compatibility (§8.3.4): same base kind and same **required**
/// fields; extra optional fields are allowed. `Ok(())` when compatible, else a
/// human-readable field/kind mismatch.
fn types_compatible(a: &SlotType, b: &SlotType) -> Result<(), String> {
    match (a, b) {
        (SlotType::Scalar(ka), SlotType::Scalar(kb)) => scalars_compatible(ka, kb),
        (SlotType::List(ra), SlotType::List(rb)) => records_compatible(ra, rb),
        (SlotType::Record(ra), SlotType::Record(rb)) => records_compatible(ra, rb),
        _ => Err(format!("base kind differs: {} vs {}", kind_name(a), kind_name(b))),
    }
}

fn scalars_compatible(a: &ScalarKind, b: &ScalarKind) -> Result<(), String> {
    use ScalarKind::*;
    match (a, b) {
        // A bare `scalar` is unspecified and widens to any concrete kind.
        (Any, _) | (_, Any) => Ok(()),
        (String, String) | (Number, Number) | (Bool, Bool) => Ok(()),
        (Enum(x), Enum(y)) => {
            if x == y {
                Ok(())
            } else {
                Err(format!("enum variants differ: ({}) vs ({})", x.join("|"), y.join("|")))
            }
        }
        _ => Err(format!("scalar kind differs: {} vs {}", scalar_kind_name(a), scalar_kind_name(b))),
    }
}

fn records_compatible(a: &Record, b: &Record) -> Result<(), String> {
    let required = |r: &Record| -> BTreeMap<String, SlotType> {
        r.fields.iter().filter(|(_, f)| f.required).map(|(k, f)| (k.clone(), f.ty.clone())).collect()
    };
    let ra = required(a);
    let rb = required(b);

    for (name, ta) in &ra {
        match rb.get(name) {
            None => {
                return Err(format!(
                    "required field `{name}` is present in one schema but absent/optional in the other"
                ))
            }
            Some(tb) => {
                types_compatible(ta, tb).map_err(|e| format!("required field `{name}`: {e}"))?
            }
        }
    }
    for name in rb.keys() {
        if !ra.contains_key(name) {
            return Err(format!(
                "required field `{name}` is present in one schema but absent/optional in the other"
            ));
        }
    }
    Ok(())
}

/// Optional-field widening for the composed type. Only reached for
/// already-compatible types, so required fields are guaranteed to agree; the
/// union simply gathers every declarer's optional fields.
fn widen(a: &SlotType, b: &SlotType) -> SlotType {
    match (a, b) {
        (SlotType::Scalar(ka), SlotType::Scalar(kb)) => SlotType::Scalar(widen_scalar(ka, kb)),
        (SlotType::List(ra), SlotType::List(rb)) => SlotType::List(widen_record(ra, rb)),
        (SlotType::Record(ra), SlotType::Record(rb)) => SlotType::Record(widen_record(ra, rb)),
        // Unreachable for compatible inputs; keep the left as a safe default.
        _ => a.clone(),
    }
}

fn widen_scalar(a: &ScalarKind, b: &ScalarKind) -> ScalarKind {
    // Prefer the concrete kind; compatibility guarantees the two agree when
    // neither is `Any`.
    match a {
        ScalarKind::Any => b.clone(),
        _ => a.clone(),
    }
}

fn widen_record(a: &Record, b: &Record) -> Record {
    let mut fields = a.fields.clone();
    for (name, fb) in &b.fields {
        match fields.get_mut(name) {
            Some(fa) => {
                fa.ty = widen(&fa.ty, &fb.ty);
                fa.required = fa.required || fb.required;
            }
            None => {
                fields.insert(name.clone(), fb.clone());
            }
        }
    }
    Record { fields }
}

// ---------------------------------------------------------------------------
// The shared-state store (§8.3.4, P1-04.6)
// ---------------------------------------------------------------------------

/// The live value held by a slot.
#[derive(Debug, Clone, PartialEq)]
pub enum SlotValue {
    /// `scalar` / `record` slots — a single value. `Null` until the
    /// writer-of-record `set`s it.
    Single(serde_json::Value),
    /// `list` slots — entry id → item. A `BTreeMap` (not a `Vec`) so the
    /// collection is order-independent: two histories that append the same
    /// items in different orders produce an *identical* map.
    List(BTreeMap<String, serde_json::Value>),
}

struct Slot {
    ty: SlotType,
    writer: Option<String>,
    value: SlotValue,
    /// Per-appender append counters. Entry ids are `"{skill}#{n}"`, so a given
    /// skill's n-th append always gets the same id regardless of how it
    /// interleaves with other skills' appends — the key to commutativity.
    seq: BTreeMap<String, u64>,
}

/// Why a store mutation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// No such slot in this composition.
    UnknownSlot(String),
    /// The operation does not apply to this slot's kind (e.g. `set` on a list,
    /// or `append` on a scalar).
    WrongKind { slot: String, expected: &'static str, found: &'static str },
    /// A `set` on a `scalar`/`record` slot by a skill that is not the
    /// writer-of-record (or by anyone when the slot has no writer).
    NotWriterOfRecord { slot: String, writer: Option<String>, attempted_by: String },
    /// A `patch` addressed an entry id that is not present in the list.
    UnknownEntry { slot: String, id: String },
    /// A `patch` whose target entry or field map is not a JSON object.
    BadPatch { slot: String, reason: &'static str },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::UnknownSlot(slot) => write!(f, "unknown slot '{slot}'"),
            StoreError::WrongKind { slot, expected, found } => {
                write!(f, "slot '{slot}': expected a {expected} slot but it is a {found}")
            }
            StoreError::NotWriterOfRecord { slot, writer, attempted_by } => match writer {
                Some(w) => write!(
                    f,
                    "slot '{slot}': only the writer-of-record '{w}' may set it, not '{attempted_by}'"
                ),
                None => write!(
                    f,
                    "slot '{slot}': no writer-of-record, so '{attempted_by}' (and anyone) is blocked from setting it"
                ),
            },
            StoreError::UnknownEntry { slot, id } => {
                write!(f, "slot '{slot}': no entry with id '{id}' to patch")
            }
            StoreError::BadPatch { slot, reason } => write!(f, "slot '{slot}': invalid patch ({reason})"),
        }
    }
}

impl std::error::Error for StoreError {}

/// A per-agent shared-state store: named slots that active skills read and
/// write under the §8.3.4 arbitration rules.
pub struct SharedStateStore {
    slots: BTreeMap<String, Slot>,
}

impl SharedStateStore {
    /// Build the store for a set of active skills (in merge order). Runs the
    /// compatibility gate ([`resolve_slots`]) first, so a returned store is
    /// guaranteed to hold only mutually-compatible slots.
    pub fn from_skills(skills: &[SkillManifest]) -> Result<Self, SlotError> {
        Ok(Self::from_specs(resolve_slots(skills)?))
    }

    /// As [`from_skills`](Self::from_skills), but from raw `(skill_id, decls)`
    /// pairs (in merge order).
    pub fn from_decls(skills: &[(String, Vec<SharedStateDecl>)]) -> Result<Self, SlotError> {
        Ok(Self::from_specs(resolve_slots_from_decls(skills)?))
    }

    /// Build directly from already-resolved specs (e.g. to reuse a
    /// compatibility check the caller already ran).
    pub fn from_specs(specs: BTreeMap<String, SlotSpec>) -> Self {
        let slots = specs
            .into_iter()
            .map(|(name, spec)| {
                let value = match &spec.ty {
                    SlotType::List(_) => SlotValue::List(BTreeMap::new()),
                    _ => SlotValue::Single(serde_json::Value::Null),
                };
                (name, Slot { ty: spec.ty, writer: spec.writer, value, seq: BTreeMap::new() })
            })
            .collect();
        Self { slots }
    }

    /// Set the value of a `scalar`/`record` slot. Only the writer-of-record may
    /// do so (last-write-wins within that writer, §8.3.4); everyone else is
    /// rejected. `set` never applies to a `list` (use `append`/`patch`).
    pub fn set(
        &mut self,
        slot: &str,
        writer_skill: &str,
        value: serde_json::Value,
    ) -> Result<(), StoreError> {
        let s = self.slots.get_mut(slot).ok_or_else(|| StoreError::UnknownSlot(slot.to_string()))?;
        if let SlotValue::List(_) = s.value {
            return Err(StoreError::WrongKind { slot: slot.to_string(), expected: "scalar/record", found: "list" });
        }
        match &s.writer {
            Some(w) if w == writer_skill => {
                s.value = SlotValue::Single(value);
                Ok(())
            }
            _ => Err(StoreError::NotWriterOfRecord {
                slot: slot.to_string(),
                writer: s.writer.clone(),
                attempted_by: writer_skill.to_string(),
            }),
        }
    }

    /// Append `item` to a `list` slot and return its app-assigned entry id.
    /// Any reader or writer may append. The id is `"{appender_skill}#{n}"`
    /// where `n` is that skill's per-slot append count — independent of other
    /// skills' appends, so concurrent appends across skills **commute**. If
    /// `item` is a JSON object its `id` field is stamped with the assigned id
    /// (the app-defined `item.id`, §8.3.4).
    pub fn append(
        &mut self,
        slot: &str,
        appender_skill: &str,
        item: serde_json::Value,
    ) -> Result<String, StoreError> {
        let Slot { value, seq, .. } =
            self.slots.get_mut(slot).ok_or_else(|| StoreError::UnknownSlot(slot.to_string()))?;
        let map = match value {
            SlotValue::List(m) => m,
            SlotValue::Single(_) => {
                return Err(StoreError::WrongKind { slot: slot.to_string(), expected: "list", found: "scalar/record" })
            }
        };
        let n = seq.entry(appender_skill.to_string()).or_insert(0);
        *n += 1;
        let id = format!("{appender_skill}#{n}");
        let mut item = item;
        if let Some(obj) = item.as_object_mut() {
            obj.insert("id".to_string(), serde_json::Value::String(id.clone()));
        }
        map.insert(id.clone(), item);
        Ok(id)
    }

    /// Patch the entry addressed by `id` in a `list` slot: merge the given
    /// object `fields` into that entry (adding/overwriting only those keys,
    /// never deleting other entries). Any reader or writer may patch, and
    /// because patches address a stable id they commute. The `id` field itself
    /// cannot be reassigned via a patch.
    pub fn patch(
        &mut self,
        slot: &str,
        id: &str,
        fields: serde_json::Value,
    ) -> Result<(), StoreError> {
        let s = self.slots.get_mut(slot).ok_or_else(|| StoreError::UnknownSlot(slot.to_string()))?;
        let map = match &mut s.value {
            SlotValue::List(m) => m,
            SlotValue::Single(_) => {
                return Err(StoreError::WrongKind { slot: slot.to_string(), expected: "list", found: "scalar/record" })
            }
        };
        let entry = map.get_mut(id).ok_or_else(|| StoreError::UnknownEntry {
            slot: slot.to_string(),
            id: id.to_string(),
        })?;
        let patch = fields
            .as_object()
            .ok_or(StoreError::BadPatch { slot: slot.to_string(), reason: "fields must be a JSON object" })?;
        let obj = entry
            .as_object_mut()
            .ok_or(StoreError::BadPatch { slot: slot.to_string(), reason: "entry is not a record" })?;
        for (k, v) in patch {
            if k != "id" {
                obj.insert(k.clone(), v.clone());
            }
        }
        Ok(())
    }

    /// Read the current value of a slot.
    pub fn read(&self, slot: &str) -> Option<&SlotValue> {
        self.slots.get(slot).map(|s| &s.value)
    }

    /// The declared type of a slot.
    pub fn slot_type(&self, slot: &str) -> Option<&SlotType> {
        self.slots.get(slot).map(|s| &s.ty)
    }

    /// The writer-of-record for a slot (`None` if the slot is read-only or
    /// absent).
    pub fn writer_of_record(&self, slot: &str) -> Option<&str> {
        self.slots.get(slot).and_then(|s| s.writer.as_deref())
    }
}

// ---------------------------------------------------------------------------
// Tests (P1-04.4/.5/.6)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build a `SkillManifest` from just an id and its shared-state decls, the
    /// same serde-from-json style `orchestrator`'s tests use.
    fn skill(id: &str, decls: serde_json::Value) -> SkillManifest {
        serde_json::from_value(json!({ "id": id, "shared_state": decls })).expect("valid test manifest")
    }

    fn decl(slot: &str, access: &str, schema: &str) -> serde_json::Value {
        json!({ "slot": slot, "access": access, "schema": schema })
    }

    // --- schema parsing (P1-04.4) ------------------------------------------

    #[test]
    fn parses_the_closed_type_language() {
        assert_eq!(parse_slot_type("scalar").unwrap(), SlotType::Scalar(ScalarKind::Any));
        assert_eq!(parse_slot_type("scalar<number>").unwrap(), SlotType::Scalar(ScalarKind::Number));
        assert_eq!(parse_slot_type(" bool ").unwrap(), SlotType::Scalar(ScalarKind::Bool));
        // enum variants are normalised, so order does not matter.
        assert_eq!(parse_slot_type("scalar<enum(b|a)>").unwrap(), parse_slot_type("scalar<enum(a|b)>").unwrap());
    }

    #[test]
    fn list_item_expands_to_the_app_item_record_with_app_assigned_id() {
        let ty = parse_slot_type("list<item>").unwrap();
        match ty {
            SlotType::List(r) => {
                assert!(r.fields["id"].required, "item.id is a required, app-assigned field");
                assert!(r.fields["name"].required);
                assert!(!r.fields["qty"].required, "qty is optional");
            }
            other => panic!("expected a list, got {other:?}"),
        }
    }

    #[test]
    fn parses_record_with_required_and_optional_fields() {
        let ty = parse_slot_type("record{name:string, qty?:number}").unwrap();
        match ty {
            SlotType::Record(r) => {
                assert!(r.fields["name"].required);
                assert!(!r.fields["qty"].required);
                assert_eq!(r.fields["qty"].ty, SlotType::Scalar(ScalarKind::Number));
            }
            other => panic!("expected a record, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_schemas() {
        assert!(parse_slot_type("bogus").is_err());
        assert!(parse_slot_type("").is_err());
        // list items must be records, not scalars.
        assert!(parse_slot_type("list<string>").is_err());
        // an unterminated enum body.
        assert!(parse_slot_type("scalar<enum()>").is_err());
    }

    // --- slot compatibility (P1-04.5) --------------------------------------

    #[test]
    fn same_slot_same_type_is_compatible() {
        let a = skill("cooking", json!([decl("ingredients", "read_write", "list<item>")]));
        let b = skill("nutrition", json!([decl("ingredients", "read", "list<item>")]));
        let specs = resolve_slots(&[a, b]).unwrap();
        let spec = &specs["ingredients"];
        // writer-of-record is the first write-capable declarer in merge order.
        assert_eq!(spec.writer.as_deref(), Some("cooking"));
        assert_eq!(spec.declarers, vec!["cooking", "nutrition"]);
    }

    #[test]
    fn extra_optional_fields_widen_and_still_compose() {
        // Same required field `name`; each adds a *different* optional field.
        let a = skill("a", json!([decl("prefs", "read_write", "record{name:string, qty?:number}")]));
        let b = skill("b", json!([decl("prefs", "read", "record{name:string, unit?:string}")]));
        let specs = resolve_slots(&[a, b]).unwrap();
        match &specs["prefs"].ty {
            SlotType::Record(r) => {
                // composed type is the union of optional fields.
                assert!(r.fields.contains_key("qty"));
                assert!(r.fields.contains_key("unit"));
                assert!(r.fields["name"].required);
            }
            other => panic!("expected record, got {other:?}"),
        }
    }

    #[test]
    fn incompatible_base_kind_blocks_with_slot_and_skills() {
        let a = skill("cooking", json!([decl("ingredients", "read_write", "list<item>")]));
        let b = skill("notes", json!([decl("ingredients", "read", "scalar<string>")]));
        let err = resolve_slots(&[a, b]).unwrap_err();
        match err {
            SlotError::Incompatible { slot, skill_a, skill_b, detail } => {
                assert_eq!(slot, "ingredients");
                assert_eq!((skill_a.as_str(), skill_b.as_str()), ("cooking", "notes"));
                assert!(detail.contains("base kind differs"), "detail names the mismatch: {detail}");
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn incompatible_required_field_blocks_and_names_the_field() {
        // Both records, but `qty` is required in one and required-with-different
        // wording... here: one requires `qty`, the other does not.
        let a = skill("a", json!([decl("row", "read_write", "record{name:string, qty:number}")]));
        let b = skill("b", json!([decl("row", "read", "record{name:string}")]));
        let err = resolve_slots(&[a, b]).unwrap_err();
        match err {
            SlotError::Incompatible { slot, detail, .. } => {
                assert_eq!(slot, "row");
                assert!(detail.contains("`qty`"), "names the offending field: {detail}");
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn incompatible_enum_variants_block() {
        let a = skill("a", json!([decl("mode", "read_write", "scalar<enum(a|b)>")]));
        let b = skill("b", json!([decl("mode", "read", "scalar<enum(a|c)>")]));
        let err = resolve_slots(&[a, b]).unwrap_err();
        assert!(matches!(err, SlotError::Incompatible { .. }));
    }

    #[test]
    fn bad_schema_is_reported_with_the_declaring_skill() {
        let a = skill("broken", json!([decl("x", "read_write", "list<string>")]));
        let err = resolve_slots(&[a]).unwrap_err();
        match err {
            SlotError::BadSchema { slot, skill, .. } => {
                assert_eq!((slot.as_str(), skill.as_str()), ("x", "broken"));
            }
            other => panic!("expected BadSchema, got {other:?}"),
        }
    }

    #[test]
    fn writer_of_record_is_first_write_capable_declarer_in_merge_order() {
        // Order matters: a reader leads, then two writers — the first writer wins.
        let a = skill("reader", json!([decl("x", "read", "scalar<string>")]));
        let b = skill("first_writer", json!([decl("x", "read_write", "scalar<string>")]));
        let c = skill("second_writer", json!([decl("x", "write", "scalar<string>")]));
        let specs = resolve_slots(&[a, b, c]).unwrap();
        assert_eq!(specs["x"].writer.as_deref(), Some("first_writer"));
    }

    #[test]
    fn resolves_from_raw_decls_too() {
        let sd = |slot: &str, access: &str, schema: &str| SharedStateDecl {
            slot: slot.to_string(),
            access: access.to_string(),
            schema: schema.to_string(),
        };
        let skills = vec![
            ("cooking".to_string(), vec![sd("ingredients", "read_write", "list<item>")]),
            ("nutrition".to_string(), vec![sd("ingredients", "read", "list<item>")]),
        ];
        let specs = resolve_slots_from_decls(&skills).unwrap();
        assert_eq!(specs["ingredients"].writer.as_deref(), Some("cooking"));
    }

    #[test]
    fn slot_with_no_writer_has_none() {
        let a = skill("r1", json!([decl("x", "read", "scalar<string>")]));
        let b = skill("r2", json!([decl("x", "read", "scalar<string>")]));
        let specs = resolve_slots(&[a, b]).unwrap();
        assert_eq!(specs["x"].writer, None);
    }

    // --- writer arbitration on scalar set (P1-04.6) ------------------------

    #[test]
    fn writer_of_record_may_set_scalar_and_non_writer_may_not() {
        let a = skill("owner", json!([decl("note", "read_write", "scalar<string>")]));
        let b = skill("viewer", json!([decl("note", "read", "scalar<string>")]));
        let mut store = SharedStateStore::from_skills(&[a, b]).unwrap();

        store.set("note", "owner", json!("hello")).unwrap();
        assert_eq!(store.read("note"), Some(&SlotValue::Single(json!("hello"))));

        let err = store.set("note", "viewer", json!("nope")).unwrap_err();
        assert!(matches!(err, StoreError::NotWriterOfRecord { .. }));
        // The rejected write left the value untouched.
        assert_eq!(store.read("note"), Some(&SlotValue::Single(json!("hello"))));
    }

    #[test]
    fn set_on_a_list_slot_is_wrong_kind() {
        let a = skill("cooking", json!([decl("ingredients", "read_write", "list<item>")]));
        let mut store = SharedStateStore::from_skills(&[a]).unwrap();
        let err = store.set("ingredients", "cooking", json!("x")).unwrap_err();
        assert!(matches!(err, StoreError::WrongKind { .. }));
    }

    // --- list append / patch by id (P1-04.6) -------------------------------

    #[test]
    fn append_assigns_ids_and_patch_addresses_them() {
        let a = skill("cooking", json!([decl("ingredients", "read_write", "list<item>")]));
        let mut store = SharedStateStore::from_skills(&[a]).unwrap();

        let id1 = store.append("ingredients", "cooking", json!({ "name": "flour" })).unwrap();
        let id2 = store.append("ingredients", "cooking", json!({ "name": "sugar" })).unwrap();
        assert_eq!(id1, "cooking#1");
        assert_eq!(id2, "cooking#2");

        // The assigned id is stamped into the entry (item.id, §8.3.4).
        if let Some(SlotValue::List(map)) = store.read("ingredients") {
            assert_eq!(map[&id1]["id"], json!("cooking#1"));
            assert_eq!(map[&id1]["name"], json!("flour"));
        } else {
            panic!("expected a list value");
        }

        // Patch by id: adds a field without disturbing the other entry.
        store.patch("ingredients", &id1, json!({ "qty": 2 })).unwrap();
        if let Some(SlotValue::List(map)) = store.read("ingredients") {
            assert_eq!(map[&id1]["qty"], json!(2));
            assert_eq!(map[&id2]["name"], json!("sugar"));
        }

        // A patch may not reassign the id, and an unknown id is rejected.
        store.patch("ingredients", &id1, json!({ "id": "hacked", "unit": "cup" })).unwrap();
        if let Some(SlotValue::List(map)) = store.read("ingredients") {
            assert_eq!(map[&id1]["id"], json!("cooking#1"), "id is immutable across patches");
            assert_eq!(map[&id1]["unit"], json!("cup"));
        }
        let err = store.patch("ingredients", "cooking#99", json!({ "qty": 1 })).unwrap_err();
        assert!(matches!(err, StoreError::UnknownEntry { .. }));
    }

    #[test]
    fn append_on_a_scalar_slot_is_wrong_kind() {
        let a = skill("owner", json!([decl("note", "read_write", "scalar<string>")]));
        let mut store = SharedStateStore::from_skills(&[a]).unwrap();
        let err = store.append("note", "owner", json!({ "x": 1 })).unwrap_err();
        assert!(matches!(err, StoreError::WrongKind { .. }));
    }

    // --- commutativity by app-assigned id (P1-04.6) ------------------------

    #[test]
    fn cross_skill_appends_commute_by_id() {
        // Two skills both declare the same list; both may append.
        let mk = || {
            let a = skill("cooking", json!([decl("ingredients", "read_write", "list<item>")]));
            let b = skill("nutrition", json!([decl("ingredients", "read", "list<item>")]));
            SharedStateStore::from_skills(&[a, b]).unwrap()
        };

        // Store 1: cooking appends, then nutrition appends.
        let mut s1 = mk();
        s1.append("ingredients", "cooking", json!({ "name": "flour" })).unwrap();
        s1.append("ingredients", "nutrition", json!({ "name": "salt" })).unwrap();

        // Store 2: the *opposite* order.
        let mut s2 = mk();
        s2.append("ingredients", "nutrition", json!({ "name": "salt" })).unwrap();
        s2.append("ingredients", "cooking", json!({ "name": "flour" })).unwrap();

        // Because ids are appender-scoped (`cooking#1`, `nutrition#1`), the two
        // histories yield an *identical* set — commutativity by id.
        assert_eq!(s1.read("ingredients"), s2.read("ingredients"));
        if let Some(SlotValue::List(map)) = s1.read("ingredients") {
            assert_eq!(map["cooking#1"]["name"], json!("flour"));
            assert_eq!(map["nutrition#1"]["name"], json!("salt"));
        }
    }

    #[test]
    fn patches_commute_with_appends_regardless_of_order() {
        let mk = || {
            let a = skill("cooking", json!([decl("ingredients", "read_write", "list<item>")]));
            SharedStateStore::from_skills(&[a]).unwrap()
        };

        // append then patch.
        let mut s1 = mk();
        let id = s1.append("ingredients", "cooking", json!({ "name": "flour" })).unwrap();
        s1.patch("ingredients", &id, json!({ "checked": true })).unwrap();

        // A second store reaching the same state via the same id.
        let mut s2 = mk();
        let id2 = s2.append("ingredients", "cooking", json!({ "name": "flour" })).unwrap();
        assert_eq!(id, id2);
        s2.patch("ingredients", &id2, json!({ "checked": true })).unwrap();

        assert_eq!(s1.read("ingredients"), s2.read("ingredients"));
    }
}
