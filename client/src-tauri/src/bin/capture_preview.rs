//! Preview-transcript capture tool (Plan Task 17, phase 1 of 2 — BUILD only;
//! the lead runs the real-model capture separately).
//!
//! Loads the REAL inference engine + one skill's persona, runs a FIXED,
//! server-chosen set of demo inputs through the SAME turn machine
//! (`crate::turn::run_turn`) the shipped app uses, and writes a curated-ready
//! transcript to `previews/<skill-id>.json`. These become the raw material for
//! the try-before-buy previews (SPEC §11.4; BE §4.2 N1 — a preview is built
//! from fixed, server-chosen inputs, never a live user prompt).
//!
//! ## Why this file reuses `src/*.rs` via `#[path]` instead of a lib crate
//!
//! This crate is deliberately a plain binary (`Cargo.toml`'s NOTE TO BUILDERS:
//! "this stays a plain binary crate rather than the lib+thin-main split").
//! Adding a second `[[bin]]` target under `src/bin/` therefore means a second,
//! independent crate root that does not automatically see `main.rs`'s module
//! tree. Rather than restructure `main.rs` into a `lib.rs` (out of scope — Rust
//! + Cargo.toml only, don't touch other modules' logic), this file re-declares
//! exactly the sibling modules it needs, pointed at the SAME source files
//! `main.rs` compiles via `#[path]`. There is no logic fork: `mod turn` here
//! and `mod turn` in `main.rs` are the same `turn.rs`, compiled twice (once per
//! binary crate), byte-for-byte identical.
//!
//! The full dependency closure needed to drive `run_turn` + the real engine is
//! small: `ipc` (leaf), `tool_catalog` (needs `ipc`), `grammar` (needs
//! `tool_catalog`), `turn` (needs `ipc` + `tool_catalog`, and calls
//! `crate::grammar::tool_call_grammar()` internally) — always compiled — plus
//! `tools` (needs `ipc` + `tool_catalog`) and `inference` (needs all of the
//! above) — compiled ONLY under `real-inference`, so a mock-inference build of
//! this bin stays toolchain-free like the rest of the crate.
//!
//! ## Two halves
//!
//! - The CORE (`capture_skill_preview`, `load_persona`/`compose_persona`, the
//!   `fixed_inputs` table, `write_preview`) is engine-agnostic — generic over
//!   [`turn::Engine`] — and compiles + unit-tests under `mock-inference` alone,
//!   no llama.cpp, no GGUF: `cargo test --no-default-features --features
//!   mock-inference capture` from `client/src-tauri/`.
//! - `main()` and the `RealChatEngine` glue that drives the REAL llama.cpp
//!   engine are `#[cfg(feature = "real-inference")]` — built (compile-checked)
//!   here, but the lead runs the actual capture (see the report for the exact
//!   command with the toolchain env).

#[path = "../ipc.rs"]
mod ipc;
#[path = "../tool_catalog.rs"]
mod tool_catalog;
#[path = "../grammar.rs"]
mod grammar;
#[path = "../turn.rs"]
mod turn;

#[cfg(feature = "real-inference")]
#[path = "../tools.rs"]
mod tools;
#[cfg(feature = "real-inference")]
#[path = "../inference.rs"]
mod inference;

use serde::Serialize;
use serde_json::Value;
use tool_catalog::{ToolName, TypedArgs};
use turn::{Engine, ToolExecError, ToolRunner, TurnConfig};

/// MUST match `composition::BASE_PREAMBLE` (`client/src-tauri/src/composition.rs`)
/// byte for byte. Duplicated here rather than importing `composition.rs` —
/// that module pulls in `manifest.rs`'s full schema validator (1800+ lines),
/// `capacity.rs`, and `tool_routing.rs` purely to reach one `pub const`, none
/// of which this headless capture tool has any other use for. If the base
/// voice ever changes, change both (see the report's concerns section).
const BASE_PREAMBLE: &str = "You are Hydropark, a private assistant that runs fully on-device. You are \
     offline and never send the conversation anywhere. Be helpful, concise, and honest.";

/// All ten catalog skills this bin knows how to capture, in `contracts/catalog/`
/// order.
pub const ALL_SKILL_IDS: [&str; 10] = [
    "kitchen-timer",
    "cooking-assistant",
    "budget-bills",
    "car-care",
    "garden-plants",
    "home-diy",
    "nutrition-coach",
    "packing-list",
    "study-flashcards",
    "travel-planner",
];

/// The FIXED, server-chosen demo inputs per skill (BE §4.2 N1: never
/// user-supplied). Three per skill, hand-curated from that skill's own
/// manifest (`contracts/catalog/<id>.manifest.json`) — a core task, a
/// tool-forcing task, and an out-of-scope/boundary task, so the captured
/// preview also shows the skill declining gracefully and pointing at the right
/// place instead of overreaching. Deliberately short (these become chat
/// bubbles in a preview modal, not a benchmark suite).
pub fn fixed_inputs(skill_id: &str) -> Option<&'static [&'static str]> {
    Some(match skill_id {
        "kitchen-timer" => &[
            "Set a 9 minute timer for the pasta.",
            "What's 350F in Celsius?",
            "What can I use instead of buttermilk?",
        ],
        "cooking-assistant" => &[
            "Quick tomato pasta for two, please.",
            "Start a 12 minute timer for the sauce.",
            "Is this keto meal okay for my diabetes?",
        ],
        "budget-bills" => &[
            "Add my bills: rent 1200, electric 80, internet 60.",
            "Split a $150 dinner bill between 4 people.",
            "Should I put my savings into index funds or pay off my car loan faster?",
        ],
        "car-care" => &[
            "I changed the oil today, 2026-07-17. It's due again in 6 months — when's that?",
            "I drove 460 km on 35 liters of fuel — what's my km per liter?",
            "My brake pedal feels spongy — can you tell me how to bleed the brakes myself?",
        ],
        "garden-plants" => &[
            "Last frost here is 2026-04-15 — when can I start hardening off seedlings, about 2 weeks before that?",
            "I have a 300 cm row and want plants spaced 25 cm apart — how many fit?",
            "I found these red berries in the yard — are they safe to eat?",
        ],
        "home-diy" => &[
            "Start a materials list for painting my bedroom — I'll need paint, a roller, tape, and drop cloths.",
            "My wall area is 38 square meters and one liter of paint covers 9.5 square meters per coat. How many liters for one coat?",
            "Can you talk me through rewiring this light switch myself?",
        ],
        "nutrition-coach" => &[
            "How much protein should I aim for a day?",
            "Add up my meals today: 520, 640, 710, and a 300 snack.",
            "What should I eat to manage my type 2 diabetes?",
        ],
        "packing-list" => &[
            "Beach weekend, 2 nights — start my list.",
            "I leave on 2026-05-03 for 5 nights — when do I come back?",
            "Do I need a visa for Japan?",
        ],
        "study-flashcards" => &[
            "Turn these into flashcards: mitochondria = powerhouse of the cell; photosynthesis = process plants use to convert light into energy.",
            "I got this card right — schedule the next review 3 days from today, 2026-07-17.",
            "My exam starts in 10 minutes online — what's the answer to question 3, 'define osmosis'?",
        ],
        "travel-planner" => &[
            "Two easy days in Lisbon — we like food and views.",
            "Split 840 for lodging between the 3 of us.",
            "Will I need a visa for Vietnam?",
        ],
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Preview JSON contract — confirmed against
// client/web/src/app/marketplace/catalog.model.ts (`SkillPreview`/`PreviewMessage`/
// `buildPreview`) and catalog-stub.adapter.ts's `getPreview`. This bin writes the
// RAW captured transcript (`skill_id` + `messages[]` of role/text), the shape the
// task spec calls for; the lead's curation step maps `messages` -> the wire
// `SkillPreview.transcript` and adds `name`/`panels`/`capped`/`no_purchase` (see
// the report for the exact field mapping and why they differ).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CapturedMessage {
    pub role: String, // "user" | "assistant"
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CapturedPreview {
    pub skill_id: String,
    pub messages: Vec<CapturedMessage>,
}

/// Read `<catalog_dir>/<skill_id>.manifest.json` and return the composed system
/// prompt: [`BASE_PREAMBLE`] + the skill's full `persona.system_prompt`, joined
/// exactly the way `orchestrator::assemble_persona` joins a base + a PRIMARY
/// skill's full prompt (`base.trim() + "\n\n" + system_prompt.trim()`, dropping
/// either half if empty). A single-skill preview always treats the skill as
/// primary regardless of its manifest `role` — all ten catalog skills declare
/// `primary_eligible` today (checked by hand across `contracts/catalog/*.json`),
/// so this never actually diverges from what `orchestrator::merge` would choose,
/// but is written this way so a future `secondary_only` skill still gets its
/// full voice in its own preview rather than being silently downgraded to its
/// compressed teaser.
pub fn load_persona(catalog_dir: &std::path::Path, skill_id: &str) -> Result<String, String> {
    let path = catalog_dir.join(format!("{skill_id}.manifest.json"));
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let manifest: Value =
        serde_json::from_str(&raw).map_err(|e| format!("parsing {}: {e}", path.display()))?;
    let system_prompt = manifest
        .get("persona")
        .and_then(|p| p.get("system_prompt"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!("{}: persona.system_prompt is missing or not a string", path.display())
        })?;
    Ok(compose_persona(BASE_PREAMBLE, system_prompt))
}

fn compose_persona(base: &str, system_prompt: &str) -> String {
    let base = base.trim();
    let sp = system_prompt.trim();
    match (base.is_empty(), sp.is_empty()) {
        (true, true) => String::new(),
        (true, false) => sp.to_string(),
        (false, true) => base.to_string(),
        (false, false) => format!("{base}\n\n{sp}"),
    }
}

/// A [`ToolRunner`] usable with no live app/`AppState`: the three STATELESS
/// catalog tools (`convert_units`, `calculate`, `date_math`) execute for real
/// via [`tool_catalog::execute`]; the two STATEFUL ones (`start_timer`,
/// `list_manage`, which normally run against the Tauri `AppState`) return a
/// canned success so a tool-forcing fixed input can still complete its turn and
/// produce a follow-up assistant line. Mirrors the `TestRunner` pattern already
/// used by `inference.rs`'s own mock-engine tests.
pub struct PreviewToolRunner;

impl ToolRunner for PreviewToolRunner {
    fn run(&mut self, name: ToolName, args: &TypedArgs) -> Result<Value, ToolExecError> {
        if tool_catalog::is_stateful(name) {
            Ok(serde_json::json!({ "ok": true, "tool": name.as_ref_str() }))
        } else {
            tool_catalog::execute(args)
                .map(tool_result_to_json)
                .map_err(|e| ToolExecError::failed(name, e.to_string()))
        }
    }
}

fn tool_result_to_json(r: tool_catalog::ToolResult) -> Value {
    use tool_catalog::ToolResult as TR;
    match r {
        TR::StartTimer(x) => serde_json::to_value(x),
        TR::ConvertUnits(x) => serde_json::to_value(x),
        TR::ListManage(x) => serde_json::to_value(x),
        TR::Calculate(x) => serde_json::to_value(x),
        TR::DateMath(x) => serde_json::to_value(x),
    }
    .unwrap_or(Value::Null)
}

/// Drive the FIXED inputs for one skill through [`turn::run_turn`], collecting
/// only the user/assistant lines a shopper would see in a preview (tool calls,
/// results, and errors are execution detail — the final prose per turn is what
/// lands in the transcript). Pure/generic over the engine: this is the
/// library-style core the mock-inference test drives, and what `main()` drives
/// with the real engine.
pub fn capture_skill_preview<E: Engine>(engine: &mut E, skill_id: &str, inputs: &[&str]) -> CapturedPreview {
    let mut messages = Vec::with_capacity(inputs.len() * 2);
    let mut runner = PreviewToolRunner;
    for &input in inputs {
        messages.push(CapturedMessage { role: "user".to_string(), text: input.to_string() });
        let transcript = turn::run_turn(engine, &mut runner, input, &TurnConfig::default());
        messages.push(CapturedMessage { role: "assistant".to_string(), text: final_reply(&transcript) });
    }
    CapturedPreview { skill_id: skill_id.to_string(), messages }
}

/// The assistant-visible text for one turn: the final prose if the turn ended
/// in one, else the graceful fallback's clarifying question (a preview still
/// has to show SOMETHING), else a diagnostic placeholder that makes a bad turn
/// (e.g. the hop-limit cap) visible to the lead during curation rather than
/// silently emitting an empty chat bubble.
fn final_reply(t: &turn::Transcript) -> String {
    if let Some(p) = t.final_prose() {
        return p.to_string();
    }
    if let Some(fb) = t.fallback() {
        if let Some(q) = &fb.clarifying_question {
            return q.clone();
        }
    }
    "[capture_preview: turn ended with no assistant prose — check the hop limit / engine output]"
        .to_string()
}

/// Write `<out_dir>/<skill_id>.json` (creating `out_dir` if needed) and return
/// the path written.
pub fn write_preview(
    out_dir: &std::path::Path,
    preview: &CapturedPreview,
) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("creating {}: {e}", out_dir.display()))?;
    let path = out_dir.join(format!("{}.json", preview.skill_id));
    let json = serde_json::to_string_pretty(preview).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// main() — the REAL capture. Loads the real engine ONCE, then for each
// requested skill: build its persona, run the fixed inputs, write
// previews/<skill-id>.json. The lead runs this (see the report for the exact
// command + toolchain env); this ticket only builds + compile-checks it.
// ---------------------------------------------------------------------------

#[cfg(feature = "real-inference")]
struct RealChatEngine<'a> {
    engine: &'a inference::real::Engine,
    system: String,
    max_new: usize,
}

#[cfg(feature = "real-inference")]
impl Engine for RealChatEngine<'_> {
    fn generate(&mut self, prompt: &str, grammar: &str) -> turn::GenOutput {
        // `prompt` is `turn.rs`'s running `<user>...</user>` (+ any tool
        // feedback) — wrap it as the user turn of the Qwen2.5 ChatML template
        // around THIS skill's composed persona (NOT `inference::real::
        // build_chatml_prompt`, which hardcodes the Phase-0 cooking prompt).
        let chatml = format!(
            "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n",
            system = self.system,
            user = prompt,
        );
        let mut full = String::new();
        let result = inference::real::generate_stream(
            self.engine,
            &chatml,
            self.max_new,
            &|| false,
            Some(grammar),
            &mut |piece: &str| full.push_str(piece),
        );
        match result {
            Ok(_stats) => inference::parse_generation(&full),
            Err(msg) => {
                eprintln!("[capture_preview] generation error: {msg}");
                turn::GenOutput::Prose(String::new())
            }
        }
    }
}

#[cfg(feature = "real-inference")]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let requested: Vec<&str> = if args.is_empty() {
        ALL_SKILL_IDS.to_vec()
    } else {
        let mut v = Vec::with_capacity(args.len());
        for a in &args {
            match ALL_SKILL_IDS.iter().find(|&&id| id == a.as_str()) {
                Some(&id) => v.push(id),
                None => {
                    eprintln!("unknown skill id '{a}'. Known ids: {}", ALL_SKILL_IDS.join(", "));
                    std::process::exit(2);
                }
            }
        }
        v
    };

    let catalog_dir = std::env::var("HYDROPARK_CATALOG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("../../contracts/catalog"));
    let out_dir = std::env::var("HYDROPARK_PREVIEW_OUT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("previews"));
    let max_new: usize =
        std::env::var("HYDROPARK_MAX_TOKENS").ok().and_then(|v| v.parse().ok()).unwrap_or(400);

    eprintln!("[capture_preview] loading the real engine (loads the GGUF once for every skill)…");
    let engine = match inference::real::Engine::load() {
        Ok(e) => e,
        Err(msg) => {
            eprintln!("[capture_preview] engine load failed: {msg}");
            std::process::exit(1);
        }
    };

    let mut failures = 0usize;
    for skill_id in requested {
        let inputs = fixed_inputs(skill_id).expect("validated against ALL_SKILL_IDS above");
        eprintln!("[capture_preview] {skill_id}: building persona from {}…", catalog_dir.display());
        let system = match load_persona(&catalog_dir, skill_id) {
            Ok(s) => s,
            Err(msg) => {
                eprintln!("[capture_preview] {skill_id}: {msg}");
                failures += 1;
                continue;
            }
        };
        let mut chat_engine = RealChatEngine { engine: &engine, system, max_new };
        eprintln!("[capture_preview] {skill_id}: running {} fixed input(s)…", inputs.len());
        let preview = capture_skill_preview(&mut chat_engine, skill_id, inputs);
        match write_preview(&out_dir, &preview) {
            Ok(path) => eprintln!("[capture_preview] {skill_id}: wrote {}", path.display()),
            Err(msg) => {
                eprintln!("[capture_preview] {skill_id}: {msg}");
                failures += 1;
            }
        }
    }

    if failures > 0 {
        eprintln!("[capture_preview] {failures} skill(s) failed — see the messages above.");
        std::process::exit(1);
    }
    eprintln!("[capture_preview] done.");
}

#[cfg(not(feature = "real-inference"))]
fn main() {
    eprintln!(
        "capture_preview drives the real llama.cpp engine and needs the `real-inference` feature. \
         Build/run it with --features real-inference (see the Task 17 report for the exact command). \
         Under mock-inference alone this bin exists only so its library-style capture logic compiles \
         and unit-tests: `cargo test --no-default-features --features mock-inference capture`."
    );
    std::process::exit(1);
}

// ---------------------------------------------------------------------------
// Tests — mock-inference only, no model, no llama.cpp. RED/GREEN per the Task
// 17 workflow; run with:
//   cargo test --no-default-features --features mock-inference capture
// ---------------------------------------------------------------------------
#[cfg(test)]
mod capture_tests {
    use super::*;

    /// A tiny scripted [`Engine`]: a fixed trigger phrase forces one
    /// `start_timer` tool call, any prompt already carrying tool feedback
    /// (`<tool_result`/`<tool_error`/`<repair>`) replies in prose, everything
    /// else is a plain prose reply. Deterministic, no model — proves the
    /// capture harness's SHAPE (message counts, alternating roles, the fixed
    /// user inputs surviving unchanged), not the real model's actual answers
    /// (that's the lead's real-model capture).
    struct ScriptedEngine;

    impl Engine for ScriptedEngine {
        fn generate(&mut self, prompt: &str, _grammar: &str) -> turn::GenOutput {
            let p = prompt.to_lowercase();
            if p.contains("<tool_result") || p.contains("<tool_error") || p.contains("<repair>") {
                turn::GenOutput::Prose("Done — here you go.".to_string())
            } else if p.contains("9 minute timer") {
                turn::GenOutput::ToolCall(
                    "start_timer".to_string(),
                    serde_json::json!({"label": "Pasta", "duration_sec": 540}),
                )
            } else {
                turn::GenOutput::Prose("Sure, here you go.".to_string())
            }
        }
    }

    /// An [`Engine`] that always emits a tool call, forcing `run_turn`'s hop
    /// cap so `final_reply`'s diagnostic-placeholder branch is exercised.
    struct AlwaysToolCallEngine;
    impl Engine for AlwaysToolCallEngine {
        fn generate(&mut self, _prompt: &str, _grammar: &str) -> turn::GenOutput {
            turn::GenOutput::ToolCall(
                "start_timer".to_string(),
                serde_json::json!({"label": "Loop", "duration_sec": 60}),
            )
        }
    }

    #[test]
    fn captures_the_expected_shape_for_one_skill() {
        let mut engine = ScriptedEngine;
        let inputs = fixed_inputs("kitchen-timer").expect("kitchen-timer has fixed inputs");
        let preview = capture_skill_preview(&mut engine, "kitchen-timer", inputs);

        assert_eq!(preview.skill_id, "kitchen-timer");
        assert!(!preview.messages.is_empty());
        assert_eq!(preview.messages.len(), inputs.len() * 2, "one user + one assistant line per input");

        for (i, msg) in preview.messages.iter().enumerate() {
            let expected_role = if i % 2 == 0 { "user" } else { "assistant" };
            assert_eq!(msg.role, expected_role, "roles must alternate starting with user");
        }
        let user_texts: Vec<&str> = preview.messages.iter().step_by(2).map(|m| m.text.as_str()).collect();
        assert_eq!(user_texts, inputs.to_vec(), "user lines are exactly the fixed inputs, unmodified");
        assert!(preview.messages.iter().all(|m| !m.text.trim().is_empty()), "no empty lines");

        // the tool-forcing input (contains "9 minute timer") completed its
        // tool hop and got a follow-up prose reply, not the raw tool call text.
        let assistant_texts: Vec<&str> =
            preview.messages.iter().skip(1).step_by(2).map(|m| m.text.as_str()).collect();
        assert!(assistant_texts.iter().any(|t| t.contains("Done")));
    }

    #[test]
    fn every_catalog_skill_has_three_or_four_short_fixed_inputs() {
        for &id in ALL_SKILL_IDS.iter() {
            let inputs = fixed_inputs(id).unwrap_or_else(|| panic!("{id}: no fixed inputs registered"));
            assert!((3..=4).contains(&inputs.len()), "{id}: expected 3-4 fixed inputs, got {}", inputs.len());
            for i in inputs {
                assert!(!i.trim().is_empty(), "{id}: empty fixed input");
            }
        }
        assert_eq!(fixed_inputs("no-such-skill"), None);
    }

    #[test]
    fn compose_persona_matches_the_base_plus_full_prompt_join() {
        assert_eq!(compose_persona("BASE", "FULL"), "BASE\n\nFULL");
        assert_eq!(compose_persona("  BASE  ", "  FULL  "), "BASE\n\nFULL");
        assert_eq!(compose_persona("", "FULL"), "FULL");
        assert_eq!(compose_persona("BASE", ""), "BASE");
    }

    #[test]
    fn load_persona_reads_a_real_catalog_manifest_and_prefixes_the_base_preamble() {
        // Run from client/src-tauri (cargo test's default cwd for this package).
        let catalog_dir = std::path::Path::new("../../contracts/catalog");
        let persona = load_persona(catalog_dir, "kitchen-timer")
            .expect("contracts/catalog/kitchen-timer.manifest.json exists in the checked-out repo");
        assert!(persona.starts_with(BASE_PREAMBLE));
        assert!(persona.contains("Kitchen Timer & Units"));
    }

    #[test]
    fn load_persona_reports_a_clear_error_for_an_unknown_skill() {
        let catalog_dir = std::path::Path::new("../../contracts/catalog");
        let err = load_persona(catalog_dir, "not-a-real-skill").unwrap_err();
        assert!(err.contains("not-a-real-skill"));
    }

    #[test]
    fn hop_limit_without_prose_falls_back_to_a_visible_diagnostic() {
        let mut engine = AlwaysToolCallEngine;
        let mut runner = PreviewToolRunner;
        let t = turn::run_turn(&mut engine, &mut runner, "loop forever", &TurnConfig::default());
        let reply = final_reply(&t);
        assert!(reply.contains("capture_preview"), "hop-limit turns get a visible marker, not silence");
    }

    #[test]
    fn write_preview_round_trips_the_expected_json_shape() {
        let dir = std::env::temp_dir().join(format!("hydropark-capture-preview-test-{}", std::process::id()));
        let preview = CapturedPreview {
            skill_id: "kitchen-timer".to_string(),
            messages: vec![
                CapturedMessage { role: "user".to_string(), text: "hi".to_string() },
                CapturedMessage { role: "assistant".to_string(), text: "hello".to_string() },
            ],
        };
        let path = write_preview(&dir, &preview).expect("writes previews/<id>.json");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "kitchen-timer.json");

        let raw = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["skill_id"], "kitchen-timer");
        assert_eq!(value["messages"][0]["role"], "user");
        assert_eq!(value["messages"][0]["text"], "hi");
        assert_eq!(value["messages"][1]["role"], "assistant");
        assert_eq!(value["messages"][1]["text"], "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_tool_runner_executes_stateless_tools_for_real_and_cans_stateful_ones() {
        let mut runner = PreviewToolRunner;
        // stateless: convert_units executes for real (exact arithmetic).
        let args = tool_catalog::validate_and_parse(
            "convert_units",
            &serde_json::json!({"domain":"mass","value":1.0,"from_unit":"kg","to_unit":"g"}),
        )
        .unwrap();
        let result = runner.run(ToolName::ConvertUnits, &args).unwrap();
        assert_eq!(result["value"], 1000.0);

        // stateful: start_timer gets a canned success (no live AppState here).
        let args = tool_catalog::validate_and_parse(
            "start_timer",
            &serde_json::json!({"label":"x","duration_sec":10}),
        )
        .unwrap();
        let result = runner.run(ToolName::StartTimer, &args).unwrap();
        assert_eq!(result["ok"], true);
    }
}
