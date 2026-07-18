//! Inference engine seam. Exactly one of the two `#[cfg]`-gated modules
//! below is compiled in, selected by Cargo feature (`Cargo.toml`):
//!
//!  - `mock` (default feature `mock-inference`) — a scripted, deterministic
//!    engine. No model file, no native inference dependency. This is what makes
//!    `cargo check`/`cargo build`/`cargo test` on this crate meaningful even
//!    without a GGUF or a C/C++ toolchain (see client/README.md).
//!  - `real` (feature `real-inference`) — embeds llama.cpp via the
//!    `llama-cpp-2` binding and runs qwen2.5-3b-instruct-q4_k_m in-process on
//!    a dedicated worker thread (see `mod real` below). CPU-only unless built
//!    with the `cuda` feature.
//!
//! ## P1-02.2/.3/.4/.5 — both engines are now driven by the turn machine.
//! BOTH modules implement the model-agnostic [`crate::turn::Engine`] seam
//! (`generate(prompt, grammar) -> GenOutput`), and BOTH route a user turn through
//! the shared [`crate::turn::run_turn`] state machine (generate → validate a
//! tool_call against the fixed [`crate::tool_catalog`] → one repair re-prompt →
//! graceful fallback; execute via a [`ToolRunner`] over the real catalog; feed
//! results back; bounded hops). The two-branch GBNF grammar
//! ([`crate::grammar::tool_call_grammar`]) is built once by `run_turn` and passed
//! to every `generate`: the **mock ignores it**; the **real engine applies it to
//! the llama sampler** — that application is the only turn-wiring code behind
//! `#[cfg(feature = "real-inference")]` (see `mod real`), so the mock build is
//! unaffected. The resulting [`crate::turn::Transcript`] is then surfaced as the
//! same event vocabulary both engines have always spoken (`inference://token`,
//! `inference://tool_call_detected`, `inference://tool_call_result`,
//! `inference://tool_call_fallback`, `inference://done`, `inference://error`).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::ipc::{
    self, InferenceDoneEvent, InferenceErrorEvent, InferenceStartArgs,
    InferenceToolCallDetectedEvent, InferenceToolCallFallbackEvent, InferenceToolCallResultEvent,
    InferenceTokenEvent,
};
use crate::tool_catalog::{self, ToolName, ToolResult, TypedArgs};
use crate::tools;
use crate::turn::{GenOutput, Step, ToolExecError, ToolRunner, Transcript};

/// Tracks which sessions have an in-flight `inference_cancel` request.
/// Checked by the engine between token emissions (mirrors
/// `MockIpcService`'s `cancelledSessions` set on the Angular side).
#[derive(Clone, Default)]
pub struct CancelRegistry(Arc<Mutex<HashSet<String>>>);

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self, session_id: &str) {
        self.0.lock().expect("cancel registry poisoned").insert(session_id.to_string());
    }
    pub fn clear(&self, session_id: &str) {
        self.0.lock().expect("cancel registry poisoned").remove(session_id);
    }
    pub fn is_cancelled(&self, session_id: &str) -> bool {
        self.0.lock().expect("cancel registry poisoned").contains(session_id)
    }
}

// ---------------------------------------------------------------------------
// Shared generation-parsing + turn wiring (compiled into BOTH builds).
// ---------------------------------------------------------------------------

/// Extracts and parses a Qwen-native
/// `<tool_call>{"name":…,"arguments":…}</tool_call>` block with a plain JSON
/// parse. Returns `None` on anything that isn't well-formed JSON.
pub fn extract_tool_call(text: &str) -> Option<Value> {
    const START: &str = "<tool_call>";
    const END: &str = "</tool_call>";
    let start = text.find(START)? + START.len();
    let end = text[start..].find(END)? + start;
    let json_text = text[start..end].trim();
    serde_json::from_str(json_text).ok()
}

/// Scans `text` (which must start with `{`) for the byte offset just past the
/// matching top-level closing `}`, honoring string quoting/escaping so a `{`
/// or `}` inside a JSON string literal (e.g. an ingredient `label`) doesn't
/// desync the brace count. Returns `None` if the braces never balance.
fn balanced_json_object_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Recognizes a BARE `{"name": …, "arguments": …}` tool call — no
/// `<tool_call>` wrapper — that a real (esp. smaller) model can emit despite
/// being instructed to wrap it, sometimes with a trailing prose line the model
/// appended after the JSON (root cause of the "raw JSON leaks into chat, tool
/// never runs" bug: the two-branch GBNF's `prose` production has no way to
/// exclude bare `{…}` text, so this shape sails through constrained decoding
/// as ordinary prose). Scoped deliberately tight to avoid misfiring on chat
/// text that merely *mentions* JSON:
///   - the object must start at byte 0 of the trimmed generation (ordinary
///     prose essentially never opens with a raw `{`; any leading chat text
///     before an embedded JSON snippet fails this immediately);
///   - it must parse as a JSON object with a non-empty string `name` AND a
///     present `arguments` key (both keys — not just one — line up with the
///     tool_call shape and further shrink the false-positive surface).
/// Anything after the matched closing `}` (e.g. the model's trailing prose
/// confirmation) is discarded, mirroring how the wrapped form already
/// discards everything outside its `<tool_call>…</tool_call>` tags.
fn extract_bare_tool_call(trimmed: &str) -> Option<Value> {
    let end = balanced_json_object_end(trimmed)?;
    let value: Value = serde_json::from_str(&trimmed[..end]).ok()?;
    let obj = value.as_object()?;
    let has_name = obj.get("name").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if has_name && obj.contains_key("arguments") {
        Some(value)
    } else {
        None
    }
}

/// Turn a parsed `{name, arguments}` JSON value into the [`GenOutput`] the
/// turn machine consumes. `on_empty_name` is the raw text to carry into
/// `Malformed` if `name` turns out to be missing/empty (kept as a parameter
/// so callers can preserve the ORIGINAL untrimmed generation there, matching
/// existing `Malformed` reporting).
fn classify_tool_value(value: &Value, on_empty_name: &str) -> GenOutput {
    let name = value.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = value.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({}));
    if name.is_empty() {
        GenOutput::Malformed(on_empty_name.to_string())
    } else {
        GenOutput::ToolCall(name.to_string(), args)
    }
}

/// Recognizes a generation that is ENTIRELY (after trim, nothing before or
/// after) a single balanced JSON object that does NOT have the `{name,
/// arguments}` tool-call shape — e.g. the model echoing back a fed-back
/// `<tool_result>` payload such as `{"timer_id":"...","label":"...",...}` as
/// its own reply instead of a natural-language confirmation (W02a — the live
/// "raw JSON result shown in chat" bug: `TurnContext::push_result`, run_turn.rs,
/// hands a small model that exact JSON verbatim as feedback with no example
/// of how to respond to it, and it sometimes just repeats it back). Anything
/// with a `name`/`arguments` shape was already claimed by
/// [`extract_bare_tool_call`] above, and anything with LEADING or TRAILING
/// text around the object is left alone (genuine prose that merely contains a
/// JSON-ish snippet, e.g. `leading_json_object_without_tool_call_shape_is_not_misdetected`).
/// Deliberately scoped to OBJECTS ONLY (not bare scalars/strings/arrays) so a
/// model's legitimate one-word/one-number prose reply (e.g. answering "what's
/// 6 times 7?" with "42") is never misdetected as a leak.
fn is_non_tool_call_json_leak(trimmed: &str) -> bool {
    match balanced_json_object_end(trimmed) {
        Some(end) if end == trimmed.len() => {
            extract_bare_tool_call(trimmed).is_none() && serde_json::from_str::<Value>(trimmed).is_ok()
        }
        _ => false,
    }
}

/// Classify one raw model generation into the [`GenOutput`] the turn machine
/// consumes: a `<tool_call>` block that parses to `{name, arguments}` becomes a
/// `ToolCall` (still unvalidated — the machine validates against the catalog);
/// a `<tool_call>` that doesn't parse becomes `Malformed`. Failing that, a BARE
/// `{name, arguments}` object at the start of the generation (no wrapper — see
/// [`extract_bare_tool_call`]) is ALSO recognized as a `ToolCall`, so a 3B model
/// that skips the `<tool_call>` wrapper still gets executed instead of leaking
/// raw JSON into the chat transcript. A generation that is otherwise nothing
/// but a bare JSON object with no tool-call shape (see
/// [`is_non_tool_call_json_leak`]) is treated as `Malformed` rather than
/// `Prose` — W02a — so it is routed through the existing repair/graceful-fallback
/// path instead of ever being shown to the user as raw `{...}`. Anything else
/// is genuine `Prose`. Shared by both engines so the mock feeds the machine
/// exactly what a real model would.
pub fn parse_generation(text: &str) -> GenOutput {
    const OPEN: &str = "<tool_call>";
    if text.contains(OPEN) {
        match extract_tool_call(text) {
            Some(value) => classify_tool_value(&value, text),
            None => GenOutput::Malformed(text.to_string()),
        }
    } else {
        let trimmed = text.trim();
        match extract_bare_tool_call(trimmed) {
            Some(value) => classify_tool_value(&value, text),
            None if is_non_tool_call_json_leak(trimmed) => GenOutput::Malformed(text.to_string()),
            None => GenOutput::Prose(trimmed.to_string()),
        }
    }
}

// -- tests: `parse_generation` classification, incl. the bare-JSON tool_call
//    hardening (the carbonara/start_timer live-repro bug). Pure logic, no
//    model, no Tauri app — compiled and run under either feature set. --
#[cfg(test)]
mod parse_generation_tests {
    use super::*;

    #[test]
    fn wrapped_tool_call_is_detected() {
        let raw = r#"<tool_call>{"name": "start_timer", "arguments": {"label": "Pasta", "duration_sec": 540}}</tool_call>"#;
        match parse_generation(raw) {
            GenOutput::ToolCall(name, args) => {
                assert_eq!(name, "start_timer");
                assert_eq!(args["label"], "Pasta");
                assert_eq!(args["duration_sec"], 540);
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    /// The live-repro bug: the model emits a BARE `{"name":…,"arguments":…}`
    /// object with no `<tool_call>` wrapper, followed by a trailing prose
    /// confirmation in the SAME generation. Before the fix this whole string
    /// satisfied the grammar's permissive `prose` branch and was returned as
    /// `GenOutput::Prose` verbatim — raw JSON shown in chat, tool never run.
    #[test]
    fn bare_tool_call_with_trailing_prose_is_detected_and_trailing_text_is_discarded() {
        let raw = "{\"name\": \"start_timer\", \"arguments\": {\"label\": \"carbonara for 4\", \"duration_sec\": 1800}}\n\
                    Will cook your carbonara for 4 people in 30 minutes.";
        match parse_generation(raw) {
            GenOutput::ToolCall(name, args) => {
                assert_eq!(name, "start_timer");
                assert_eq!(args["label"], "carbonara for 4");
                assert_eq!(args["duration_sec"], 1800);
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn bare_tool_call_with_no_trailing_text_is_detected() {
        let raw = r#"{"name": "convert_units", "arguments": {"domain": "mass", "value": 1.0, "from_unit": "kg", "to_unit": "g"}}"#;
        match parse_generation(raw) {
            GenOutput::ToolCall(name, _args) => assert_eq!(name, "convert_units"),
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn bare_tool_call_is_detected_after_leading_or_trailing_whitespace() {
        let raw = "  \n{\"name\": \"start_timer\", \"arguments\": {\"label\": \"Pasta\", \"duration_sec\": 60}}  \n";
        match parse_generation(raw) {
            GenOutput::ToolCall(name, _) => assert_eq!(name, "start_timer"),
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    /// Genuine prose that merely *mentions* JSON — the object doesn't open at
    /// byte 0 of the trimmed text — must NOT be misdetected as a tool call.
    #[test]
    fn prose_mentioning_json_mid_sentence_is_not_misdetected() {
        let raw = "Sure — a tool call looks like {\"name\": \"start_timer\", \"arguments\": {}} in general.";
        match parse_generation(raw) {
            GenOutput::Prose(text) => assert_eq!(text, raw),
            other => panic!("expected Prose, got {other:?}"),
        }
    }

    /// A leading JSON object that lacks the tool_call shape (no `name`/`arguments`
    /// pair) must NOT be misdetected as a tool call either.
    #[test]
    fn leading_json_object_without_tool_call_shape_is_not_misdetected() {
        let raw = r#"{"ingredient": "salt", "qty": 2} is roughly how I'd write that down."#;
        match parse_generation(raw) {
            GenOutput::Prose(text) => assert_eq!(text, raw),
            other => panic!("expected Prose, got {other:?}"),
        }
    }

    /// `name` present but `arguments` absent: still not the tool_call shape,
    /// so it stays Prose rather than being force-classified as a call (or a
    /// spurious Malformed) from a coincidental JSON blob.
    #[test]
    fn leading_json_object_with_name_but_no_arguments_is_not_misdetected() {
        let raw = r#"{"name": "Bob's Kitchen"} is the name of the restaurant."#;
        assert!(matches!(parse_generation(raw), GenOutput::Prose(_)));
    }

    /// A wrapped call is still checked first: text containing BOTH a leading
    /// bare-looking `{` and a `<tool_call>` wrapper elsewhere follows the
    /// existing wrapped-form path, unaffected by the new bare-form fallback.
    #[test]
    fn wrapped_form_still_takes_priority_when_present() {
        let raw = r#"<tool_call>{"name": "start_timer", "arguments": {"label": "Pasta", "duration_sec": 60}}</tool_call>"#;
        assert!(matches!(parse_generation(raw), GenOutput::ToolCall(name, _) if name == "start_timer"));
    }

    // -- W02a: a generation that is nothing but a bare JSON object with no
    //    `{name, arguments}` shape (e.g. the model echoing a fed-back
    //    `<tool_result>` payload back as its own reply) must never be shown to
    //    the user as raw `{...}` — it is reclassified `Malformed` so the turn
    //    machine's existing repair/fallback path handles it instead of
    //    `emit_steps` ever streaming it as chat prose. --

    /// The live-repro shape: exactly a `start_timer` RESULT object (no
    /// `name`/`arguments` keys — a tool RESULT, not a tool CALL) and nothing
    /// else in the generation.
    #[test]
    fn bare_echoed_tool_result_json_is_not_shown_as_raw_prose() {
        let raw = r#"{"timer_id": "tmr_1", "label": "carbonara for 4", "duration_sec": 1800, "started_at_ms": 123}"#;
        match parse_generation(raw) {
            GenOutput::Malformed(text) => assert_eq!(text, raw),
            other => panic!("expected Malformed (never raw Prose), got {other:?}"),
        }
    }

    /// A short JSON object unrelated to any tool shape at all is still caught
    /// — the check is "is this whole generation just a bare JSON object",
    /// not "does it look like a specific known result".
    #[test]
    fn bare_unrelated_json_object_is_not_shown_as_raw_prose() {
        let raw = r#"{"foo": "bar", "n": 2}"#;
        assert!(matches!(parse_generation(raw), GenOutput::Malformed(_)));
    }

    /// A leading JSON object followed by trailing prose is UNCHANGED by this
    /// hardening — it's a different scenario (mixed content, not a bare leak)
    /// already covered by `leading_json_object_without_tool_call_shape_is_not_misdetected`
    /// above, which must keep passing.
    #[test]
    fn json_object_with_trailing_prose_is_still_plain_prose_not_malformed() {
        let raw = r#"{"ingredient": "salt", "qty": 2} is roughly how I'd write that down."#;
        assert!(matches!(parse_generation(raw), GenOutput::Prose(_)));
    }

    /// A bare NON-object JSON scalar (e.g. the model answering "what's 6
    /// times 7?" with just "42") must stay genuine `Prose` — the leak guard is
    /// deliberately scoped to JSON OBJECTS only, never bare numbers/strings.
    #[test]
    fn bare_json_number_reply_is_not_misdetected_as_a_leak() {
        assert!(matches!(parse_generation("42"), GenOutput::Prose(text) if text == "42"));
    }
}

/// Map a canonical (5-tool) catalog tool onto the Phase-0 wire enum
/// (`crate::ipc::ToolName`, 3 tools). `calculate`/`date_math` have no wire
/// representation yet ⇒ `None` (the webview contract is still the 3 cooking
/// tools; those two never appear in the wired cooking flow).
fn ipc_tool(t: ToolName) -> Option<ipc::ToolName> {
    match t {
        ToolName::StartTimer => Some(ipc::ToolName::StartTimer),
        ToolName::ConvertUnits => Some(ipc::ToolName::ConvertUnits),
        ToolName::ListManage => Some(ipc::ToolName::ListManage),
        ToolName::Calculate | ToolName::DateMath => None,
    }
}

/// Serialize a typed catalog result to JSON for the `tool_call_result` event.
fn tool_result_to_json(r: ToolResult) -> Value {
    match r {
        ToolResult::StartTimer(x) => serde_json::to_value(x),
        ToolResult::ConvertUnits(x) => serde_json::to_value(x),
        ToolResult::ListManage(x) => serde_json::to_value(x),
        ToolResult::Calculate(x) => serde_json::to_value(x),
        ToolResult::DateMath(x) => serde_json::to_value(x),
    }
    .unwrap_or(Value::Null)
}

/// The production [`ToolRunner`]: runs a validated, typed catalog call for real.
/// The two STATEFUL tools (`start_timer`, `list_manage`) execute against the Tool
/// Runtime's `AppState` via `tools.rs`; the three STATELESS tools run purely via
/// [`tool_catalog::execute`]. A structured failure is surfaced as [`ToolExecError`],
/// which the turn machine feeds back to the model (SPEC §8.4 pt 4).
pub struct CatalogToolRunner {
    state: tools::AppState,
    app: AppHandle,
}

impl CatalogToolRunner {
    pub fn new(state: tools::AppState, app: AppHandle) -> Self {
        Self { state, app }
    }
}

impl ToolRunner for CatalogToolRunner {
    fn run(&mut self, name: ToolName, args: &TypedArgs) -> Result<Value, ToolExecError> {
        match name {
            ToolName::StartTimer | ToolName::ListManage => {
                // Stateful — bridge the shared `ipc::*Args` into `tools.rs`'s typed
                // enum and execute against the app's timer/ingredient state.
                let typed = match args {
                    TypedArgs::StartTimer(a) => tools::TypedToolArgs::StartTimer(a.clone()),
                    TypedArgs::ListManage(a) => tools::TypedToolArgs::ListManage(a.clone()),
                    _ => return Err(ToolExecError::failed(name, "stateful dispatch mismatch")),
                };
                tools::execute(&self.state, &self.app, typed)
                    .map(|(_tool, value)| value)
                    .map_err(|e| ToolExecError::failed(name, e.to_string()))
            }
            ToolName::ConvertUnits | ToolName::Calculate | ToolName::DateMath => {
                tool_catalog::execute(args)
                    .map(tool_result_to_json)
                    .map_err(|e| ToolExecError::failed(name, e.to_string()))
            }
        }
    }
}

/// Splits on whitespace runs while keeping them as their own tokens, so streamed
/// output reproduces natural spacing (equivalent to the TS mock's
/// `text.split(/(\s+)/).filter(w => w.length > 0)`).
fn split_tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_space = text.starts_with(char::is_whitespace);
    for (i, c) in text.char_indices() {
        let is_space = c.is_whitespace();
        if is_space != in_space {
            if i > start {
                out.push(&text[start..i]);
            }
            start = i;
            in_space = is_space;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// Surface a completed [`Transcript`] as the `inference://*` event vocabulary,
/// streaming any prose as word tokens. Returns the number of prose tokens emitted
/// (the mock reports this as `tokens_generated`; the real engine reports its own
/// decoded-token count instead). Honours cancellation between emissions.
fn emit_steps(app: &AppHandle, cancel: &CancelRegistry, session_id: &str, transcript: &Transcript) -> u64 {
    let mut seq: u64 = 0;
    let mut words: u64 = 0;
    for step in &transcript.steps {
        if cancel.is_cancelled(session_id) {
            break;
        }
        match step {
            Step::ToolCall { tool, args } => {
                // `Value: Display` writes compact JSON (mirrors the old mock's `raw`).
                let raw = format!(
                    "<tool_call>{{\"name\":\"{}\",\"arguments\":{}}}</tool_call>",
                    tool.as_ref_str(),
                    args
                );
                let _ = app.emit(
                    "inference://tool_call_detected",
                    InferenceToolCallDetectedEvent {
                        session_id: session_id.to_string(),
                        raw,
                        tool: ipc_tool(*tool),
                        parsed_args: Some(args.clone()),
                        valid: true,
                    },
                );
            }
            Step::ToolResult { tool, result } => {
                // The `tool_call_result` wire event names a 3-tool `ipc::ToolName`;
                // the two Phase-1-new tools have no wire slot (and never appear in the
                // wired cooking flow), so their result is simply not surfaced here.
                if let Some(t) = ipc_tool(*tool) {
                    let _ = app.emit(
                        "inference://tool_call_result",
                        InferenceToolCallResultEvent {
                            session_id: session_id.to_string(),
                            tool: t,
                            result: result.clone(),
                        },
                    );
                }
            }
            Step::ToolError { tool, error } => {
                // Surfaced (SPEC §8.4 pt 4). The machine already fed it back; the
                // model's acknowledgement streams as the subsequent prose.
                let _ = app.emit(
                    "inference://error",
                    InferenceErrorEvent {
                        session_id: session_id.to_string(),
                        message: format!("{}: {error}", tool.as_ref_str()),
                    },
                );
            }
            Step::RepairAttempt { tool, raw, .. } => {
                // The invalid detection that triggered the single repair re-prompt.
                let _ = app.emit(
                    "inference://tool_call_detected",
                    InferenceToolCallDetectedEvent {
                        session_id: session_id.to_string(),
                        raw: raw.clone(),
                        tool: (*tool).and_then(ipc_tool),
                        parsed_args: None,
                        valid: false,
                    },
                );
            }
            Step::Fallback(fb) => {
                let _ = app.emit(
                    "inference://tool_call_fallback",
                    InferenceToolCallFallbackEvent {
                        session_id: session_id.to_string(),
                        reason: fb.reason,
                        tool: fb.tool.and_then(ipc_tool),
                        parsed_args: fb.parsed_args.clone(),
                        clarifying_question: fb.clarifying_question.clone(),
                    },
                );
            }
            Step::Prose(text) => {
                for word in split_tokens(text) {
                    if cancel.is_cancelled(session_id) {
                        break;
                    }
                    let _ = app.emit(
                        "inference://token",
                        InferenceTokenEvent {
                            session_id: session_id.to_string(),
                            seq,
                            token: word.to_string(),
                        },
                    );
                    seq += 1;
                    words += 1;
                }
            }
            Step::HopLimitReached { .. } => { /* the turn simply ends; `done` follows */ }
            Step::DuplicateCallSkipped { .. } => {
                // W02b: an identical-consecutive call was deduped — no re-execution
                // happened (no second timer), so there is nothing new to show; the
                // model's nudged-toward prose confirmation (or the machine's own
                // generic give-up line) is what the user sees next, via `Step::Prose`.
            }
        }
    }
    words
}

/// Emit the terminal `inference://done` (same schema the Angular telemetry path
/// consumes). `tokens_generated` is the mock's word count or the real engine's
/// decoded-token count.
fn emit_done(app: &AppHandle, session_id: &str, tokens_generated: u64, elapsed_ms: f64) {
    let tok_per_sec = if tokens_generated > 0 && elapsed_ms > 0.0 {
        (tokens_generated as f64) / (elapsed_ms / 1000.0)
    } else {
        0.0
    };
    let _ = app.emit(
        "inference://done",
        InferenceDoneEvent {
            session_id: session_id.to_string(),
            tokens_generated,
            elapsed_ms,
            tok_per_sec: (tok_per_sec * 10.0).round() / 10.0,
        },
    );
}

/// Entry point used by `main.rs`'s `inference_start` command. Dispatches to
/// whichever engine is compiled in. `real-inference` is the default; build the
/// toolchain-free mock with `--no-default-features --features mock-inference`.
pub fn start(app: AppHandle, state: crate::tools::AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
    #[cfg(all(feature = "mock-inference", not(feature = "real-inference")))]
    mock::run(app, state, cancel, args);

    #[cfg(feature = "real-inference")]
    real::run(app, state, cancel, args);

    #[cfg(not(any(feature = "mock-inference", feature = "real-inference")))]
    compile_error!("enable either the `mock-inference` or `real-inference` feature");
}

// ---------------------------------------------------------------------------
// Mock engine — a scripted [`turn::Engine`] driven by the SAME `run_turn` state
// machine as the real engine. It replays a fixed list of raw model "turns" (the
// text a real model would emit), one per `generate` call, so the machine and the
// event surface behave identically to the real path. MIRRORS the intent of
// client/web/src/app/ipc/mock-ipc.service.ts's `scriptTurn()`.
// ---------------------------------------------------------------------------

#[cfg(all(feature = "mock-inference", not(feature = "real-inference")))]
pub mod mock {
    use super::{emit_done, emit_steps, parse_generation, CancelRegistry, CatalogToolRunner};
    use crate::ipc::{InferenceStartArgs, SkillId};
    use crate::tools::AppState;
    use crate::turn::{self, GenOutput, TurnConfig};
    use tauri::AppHandle;

    /// A scripted [`turn::Engine`]: replays raw model turns, ignoring the grammar
    /// (the mock is not constrained-decoded).
    struct MockEngine {
        turns: Vec<String>,
        idx: usize,
    }

    impl turn::Engine for MockEngine {
        fn generate(&mut self, _prompt: &str, _grammar: &str) -> GenOutput {
            let raw = self.turns.get(self.idx).cloned().unwrap_or_default();
            self.idx += 1;
            if raw.is_empty() {
                // Exhausted script ⇒ terminal empty prose (ends the turn safely).
                return GenOutput::Prose(String::new());
            }
            parse_generation(&raw)
        }
    }

    /// The scripted model turns for a user message. A turn is zero or more tool-call
    /// generations followed by a terminal prose — or a malformed / unknown-tool /
    /// invalid-args call that drives the machine's repair → graceful-fallback path.
    fn script_turns(user_message: &str, skill_enabled: bool) -> Vec<String> {
        let msg = user_message.to_lowercase();

        if !skill_enabled {
            return vec!["I'm the base Hydropark agent — I can chat, but I don't have cooking \
                 tools yet. Enable \"Kitchen Timer & Units\" and ask me again."
                .to_string()];
        }
        if msg.contains("confuse") || msg.contains("gibberish") {
            // malformed → repair → still malformed → graceful fallback (clarifying Q).
            return vec![
                "<tool_call>{not valid json at all".to_string(),
                "<tool_call>{still not valid".to_string(),
            ];
        }
        if msg.contains("unknown tool") || msg.contains("random tool") {
            // names a tool outside the audited catalog → repair → fallback (clarifying Q).
            let call = r#"<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>"#;
            return vec![call.to_string(), call.to_string()];
        }
        if msg.contains("surprise") {
            // a known tool with invalid args (missing duration_sec) → repair → fallback
            // that prefills the timer widget.
            let call =
                r#"<tool_call>{"name":"start_timer","arguments":{"label":"Mystery"}}</tool_call>"#;
            return vec![call.to_string(), call.to_string()];
        }
        if msg.contains("carbonara") {
            return vec![
                r#"<tool_call>{"name":"list_manage","arguments":{"op":"set_all","items":[{"name":"Spaghetti","qty":400.0,"unit":"g"},{"name":"Guanciale (or pancetta)","qty":150.0,"unit":"g"},{"name":"Egg yolks","qty":4.0},{"name":"Whole egg","qty":1.0},{"name":"Pecorino Romano, grated","qty":50.0,"unit":"g"},{"name":"Black pepper"}]}}</tool_call>"#.to_string(),
                r#"<tool_call>{"name":"start_timer","arguments":{"label":"Pasta","duration_sec":540}}</tool_call>"#.to_string(),
                "Your ingredient list is set and a 9:00 pasta timer is running — flip US/Metric \
                 anytime and it re-converts exactly. Want a sauce timer too?"
                    .to_string(),
            ];
        }
        vec!["Kitchen Timer & Units is on — try \"Help me cook carbonara for 4\", or use the \
             panels directly."
            .to_string()]
    }

    /// Drive one turn through [`turn::run_turn`] over the real tool catalog (via
    /// [`CatalogToolRunner`]) and surface the transcript as `inference://*` events.
    pub fn run(app: AppHandle, state: AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
        tauri::async_runtime::spawn(async move {
            let session_id = args.session_id.clone();
            cancel.clear(&session_id);
            let skill_enabled = matches!(
                args.skill_id,
                Some(SkillId::KitchenTimer) | Some(SkillId::CookingAssistant)
            );
            let mut engine =
                MockEngine { turns: script_turns(&args.user_message, skill_enabled), idx: 0 };
            let mut runner = CatalogToolRunner::new(state, app.clone());
            let start = std::time::Instant::now();
            let transcript =
                turn::run_turn(&mut engine, &mut runner, &args.user_message, &TurnConfig::default());
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            let words = emit_steps(&app, &cancel, &session_id, &transcript);
            emit_done(&app, &session_id, words, elapsed_ms);
        });
    }

    // -- tests: the turn machine driving the MOCK engine end-to-end through the
    //    new trait, over the real catalog. Pure logic — no Tauri app, no model. --
    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::tool_catalog::{self, ToolName, TypedArgs};
        use crate::turn::{run_turn, Step, ToolExecError, ToolRunner, Transcript};
        use serde_json::json;

        /// A [`ToolRunner`] over the REAL catalog: the three stateless tools execute
        /// for real via [`tool_catalog::execute`]; the two stateful tools (which need
        /// the Tauri `AppState`) return a canned success so the machine runs with no
        /// app/runtime.
        struct TestRunner;
        impl ToolRunner for TestRunner {
            fn run(&mut self, name: ToolName, args: &TypedArgs) -> Result<serde_json::Value, ToolExecError> {
                if tool_catalog::is_stateful(name) {
                    Ok(json!({ "ok": true, "tool": name.as_ref_str() }))
                } else {
                    tool_catalog::execute(args)
                        .map(super::super::tool_result_to_json)
                        .map_err(|e| ToolExecError::failed(name, e.to_string()))
                }
            }
        }

        fn drive(user: &str, skill: bool) -> Transcript {
            let mut engine = MockEngine { turns: script_turns(user, skill), idx: 0 };
            let mut runner = TestRunner;
            run_turn(&mut engine, &mut runner, user, &TurnConfig::default())
        }

        #[test]
        fn mock_engine_drives_a_full_tool_turn_end_to_end() {
            let t = drive("help me cook carbonara for 4", true);
            assert_eq!(t.tool_calls(), 2, "list_manage then start_timer");
            assert_eq!(t.tool_errors(), 0);
            assert!(t.fallback().is_none());
            assert!(t.final_prose().is_some());
            assert!(t
                .steps
                .iter()
                .any(|s| matches!(s, Step::ToolResult { tool: ToolName::ListManage, .. })));
            assert!(t
                .steps
                .iter()
                .any(|s| matches!(s, Step::ToolResult { tool: ToolName::StartTimer, .. })));
        }

        #[test]
        fn mock_engine_executes_a_stateless_catalog_tool_for_real() {
            // A hand-scripted turn that names a stateless catalog tool exercises the
            // TestRunner's real `tool_catalog::execute` path (exact arithmetic).
            let mut engine = MockEngine {
                turns: vec![
                    r#"<tool_call>{"name":"convert_units","arguments":{"domain":"mass","value":1.0,"from_unit":"kg","to_unit":"g"}}</tool_call>"#.to_string(),
                    "1 kg is 1000 g.".to_string(),
                ],
                idx: 0,
            };
            let mut runner = TestRunner;
            let t = run_turn(&mut engine, &mut runner, "convert 1 kg to g", &TurnConfig::default());
            assert_eq!(t.tool_calls(), 1);
            let result = t
                .steps
                .iter()
                .find_map(|s| match s {
                    Step::ToolResult { tool: ToolName::ConvertUnits, result } => Some(result.clone()),
                    _ => None,
                })
                .expect("a convert_units result");
            assert_eq!(result["value"], 1000.0);
            assert_eq!(t.final_prose(), Some("1 kg is 1000 g."));
        }

        #[test]
        fn mock_engine_malformed_call_repairs_then_falls_back() {
            let t = drive("please confuse me", true);
            assert_eq!(t.repairs(), 1);
            assert_eq!(t.tool_calls(), 0);
            let fb = t.fallback().expect("a graceful fallback");
            assert_eq!(fb.reason, crate::ipc::FallbackReason::MalformedJson);
            assert!(fb.tool.is_none());
            assert!(fb.clarifying_question.is_some());
        }

        #[test]
        fn mock_engine_invalid_args_prefills_the_bound_widget() {
            let t = drive("surprise me", true);
            assert_eq!(t.repairs(), 1);
            let fb = t.fallback().expect("a graceful fallback");
            assert_eq!(fb.reason, crate::ipc::FallbackReason::InvalidArgs);
            assert_eq!(fb.tool, Some(ToolName::StartTimer));
            assert!(fb.parsed_args.is_some(), "known tool ⇒ prefill the widget");
            assert!(fb.clarifying_question.is_none());
        }

        #[test]
        fn mock_engine_unknown_tool_asks_a_clarifying_question() {
            let t = drive("use an unknown tool please", true);
            let fb = t.fallback().expect("a graceful fallback");
            assert_eq!(fb.reason, crate::ipc::FallbackReason::UnknownTool);
            assert!(fb.tool.is_none());
            assert!(fb.clarifying_question.is_some());
        }

        #[test]
        fn mock_engine_prose_only_when_skill_disabled() {
            let t = drive("help me cook carbonara", false);
            assert_eq!(t.tool_calls(), 0);
            assert!(t.fallback().is_none());
            assert!(t.final_prose().unwrap().contains("base Hydropark agent"));
        }

        /// `run_turn`-level regression for the live carbonara bug: a generation
        /// that is a BARE `{"name":…,"arguments":…}` object (no `<tool_call>`
        /// wrapper) plus a trailing prose line — exactly what the real model
        /// emitted — must still drive the machine to `Step::ToolCall` +
        /// `Step::ToolResult` (the timer actually runs), never leak as raw JSON
        /// inside a `Step::Prose`.
        #[test]
        fn bare_json_tool_call_without_wrapper_executes_via_run_turn() {
            let mut engine = MockEngine {
                turns: vec![
                    "{\"name\": \"start_timer\", \"arguments\": {\"label\": \"carbonara for 4\", \"duration_sec\": 1800}}\n\
                     Will cook your carbonara for 4 people in 30 minutes."
                        .to_string(),
                ],
                idx: 0,
            };
            let mut runner = TestRunner;
            let t = run_turn(
                &mut engine,
                &mut runner,
                "help me cook carbonara for 4",
                &TurnConfig::default(),
            );
            assert_eq!(t.tool_calls(), 1, "the bare (unwrapped) JSON must still be detected as a tool call");
            assert_eq!(t.repairs(), 0);
            assert!(t.fallback().is_none());
            assert!(t
                .steps
                .iter()
                .any(|s| matches!(s, Step::ToolCall { tool: ToolName::StartTimer, .. })));
            assert!(t
                .steps
                .iter()
                .any(|s| matches!(s, Step::ToolResult { tool: ToolName::StartTimer, .. })));
            // No step may carry the raw, un-executed tool_call JSON as prose.
            assert!(
                !t.steps.iter().any(|s| matches!(s, Step::Prose(p) if p.contains("\"arguments\""))),
                "raw tool_call JSON must never leak into a Prose step: {:?}",
                t.steps
            );
        }

        /// W02a — the other live-repro half: AFTER a tool result is fed back
        /// (`TurnContext::push_result`), a small model can echo that raw JSON
        /// back verbatim instead of confirming in prose. Via `run_turn`, that
        /// echo must be classified `Malformed` (triggering the existing
        /// repair re-prompt) rather than ever reaching a `Step::Prose` — the
        /// only step type `emit_steps` streams to the chat as `inference://token`.
        #[test]
        fn echoed_tool_result_json_is_never_shown_as_raw_prose_via_run_turn() {
            let mut engine = MockEngine {
                turns: vec![
                    r#"<tool_call>{"name":"start_timer","arguments":{"label":"Pasta","duration_sec":540}}</tool_call>"#.to_string(),
                    // the model echoes the fed-back <tool_result> payload instead of confirming
                    r#"{"timer_id":"tmr_1","label":"Pasta","duration_sec":540,"started_at_ms":123}"#.to_string(),
                    "Your pasta timer is running.".to_string(),
                ],
                idx: 0,
            };
            let mut runner = TestRunner;
            let t = run_turn(&mut engine, &mut runner, "start a pasta timer", &TurnConfig::default());
            assert_eq!(t.tool_calls(), 1);
            assert_eq!(t.repairs(), 1, "the echoed JSON triggers ONE repair re-prompt, not a raw display");
            assert!(t.fallback().is_none());
            assert_eq!(t.final_prose(), Some("Your pasta timer is running."));
            assert!(
                !t.steps.iter().any(|s| matches!(s, Step::Prose(p) if p.contains("timer_id"))),
                "the echoed tool_result JSON must never appear as a Prose step: {:?}",
                t.steps
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Real engine (P0-02.1/.2, P1-02.2/.3/.4) — embeds llama.cpp via `llama-cpp-2`
// and runs qwen2.5-3b-instruct-q4_k_m in-process. It now implements the
// [`crate::turn::Engine`] seam and is driven by the SAME `run_turn` state machine
// as the mock, applying the GBNF grammar to the sampler for constrained decoding.
//
// The model + backend are loaded ONCE and owned by a single dedicated worker
// thread: llama.cpp's `LlamaModel`/`LlamaContext` handles are not `Send`, so
// rather than move them across threads we send jobs to the worker over a channel.
// A fresh `LlamaContext` (KV cache) is built per generation.
// ---------------------------------------------------------------------------
#[cfg(feature = "real-inference")]
pub mod real {
    use super::{emit_done, emit_steps, parse_generation, CancelRegistry, CatalogToolRunner};
    use crate::ipc::{InferenceErrorEvent, InferenceStartArgs, SkillId};
    use crate::tools::AppState;
    use crate::turn::{self, GenOutput, TurnConfig};

    use std::num::NonZeroU32;
    use std::path::PathBuf;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::OnceLock;
    use std::time::Instant;

    use tauri::{AppHandle, Emitter};

    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::{AddBos, LlamaModel};
    use llama_cpp_2::sampling::LlamaSampler;

    const MODEL_FILE: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";

    // ---- configuration (env-overridable) --------------------------------

    fn env_u32(key: &str, default: u32) -> u32 {
        std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    /// GPU layers to offload; only effective in a `cuda`-feature build.
    fn n_gpu_layers() -> u32 {
        env_u32("HYDROPARK_N_GPU_LAYERS", 20)
    }
    fn n_ctx() -> u32 {
        env_u32("HYDROPARK_N_CTX", 4096)
    }
    fn max_new_tokens() -> usize {
        env_u32("HYDROPARK_MAX_TOKENS", 512) as usize
    }
    fn n_threads() -> i32 {
        std::env::var("HYDROPARK_N_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| {
                std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4)
            })
    }
    fn temperature() -> f32 {
        std::env::var("HYDROPARK_TEMPERATURE").ok().and_then(|v| v.parse().ok()).unwrap_or(0.7)
    }

    /// Resolves the GGUF path. `HYDROPARK_MODEL_PATH` wins; otherwise the first
    /// existing of a set of conventional locations. Returns a clear error listing
    /// where it looked if nothing is found (fail gracefully).
    fn resolve_model_path() -> Result<PathBuf, String> {
        if let Ok(p) = std::env::var("HYDROPARK_MODEL_PATH") {
            let p = PathBuf::from(p);
            return if p.is_file() {
                Ok(p)
            } else {
                Err(format!("HYDROPARK_MODEL_PATH points at a missing file: {}", p.display()))
            };
        }
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("models").join(MODEL_FILE));
                candidates.push(dir.join("..").join("models").join(MODEL_FILE));
                candidates.push(dir.join("..").join("..").join("..").join("models").join(MODEL_FILE));
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("models").join(MODEL_FILE));
            candidates.push(cwd.join("..").join("models").join(MODEL_FILE));
        }
        for c in &candidates {
            if c.is_file() {
                return Ok(c.clone());
            }
        }
        Err(format!(
            "model file `{MODEL_FILE}` not found. Set HYDROPARK_MODEL_PATH, or place it in one of: {}",
            candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" ; ")
        ))
    }

    // ---- loaded engine (lives only on the worker thread) ----------------

    pub struct Engine {
        backend: LlamaBackend,
        model: LlamaModel,
    }

    impl Engine {
        pub fn load() -> Result<Self, String> {
            let path = resolve_model_path()?;
            let backend =
                LlamaBackend::init().map_err(|e| format!("llama.cpp backend init failed: {e}"))?;
            let gpu_layers = n_gpu_layers();
            let model_params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
            let load_start = Instant::now();
            let model = LlamaModel::load_from_file(&backend, &path, &model_params)
                .map_err(|e| format!("failed to load GGUF `{}`: {e}", path.display()))?;
            let gpu_offload_active = cfg!(feature = "cuda") && gpu_layers > 0;
            eprintln!(
                "[hydropark::inference] loaded {} in {:.1}s (n_gpu_layers={}, gpu_offload_active={}, n_ctx_train={}, threads={})",
                path.display(),
                load_start.elapsed().as_secs_f64(),
                gpu_layers,
                gpu_offload_active,
                model.n_ctx_train(),
                n_threads(),
            );
            if gpu_layers > 0 && !cfg!(feature = "cuda") {
                eprintln!(
                    "[hydropark::inference] note: n_gpu_layers={gpu_layers} requested, but this is a CPU-only build (no `cuda` feature) — running on CPU."
                );
            }
            Ok(Engine { backend, model })
        }
    }

    // ---- worker thread + job queue --------------------------------------

    struct Job {
        app: AppHandle,
        state: AppState,
        cancel: CancelRegistry,
        args: InferenceStartArgs,
    }

    static WORKER: OnceLock<Sender<Job>> = OnceLock::new();

    /// Same signature/role as `mock::run`: enqueue a turn. The first call lazily
    /// spawns the worker thread (which loads the model on its first job, so a missing
    /// model surfaces as an `inference://error`, not a startup crash).
    pub fn run(app: AppHandle, state: AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
        let session_id = args.session_id.clone();
        let err_app = app.clone();
        let tx = WORKER.get_or_init(spawn_worker);
        if tx.send(Job { app, state, cancel, args }).is_err() {
            let _ = err_app.emit(
                "inference://error",
                InferenceErrorEvent {
                    session_id,
                    message: "inference worker thread is unavailable".to_string(),
                },
            );
        }
    }

    fn spawn_worker() -> Sender<Job> {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("hydropark-inference".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || worker_loop(rx))
            .expect("failed to spawn inference worker thread");
        tx
    }

    fn worker_loop(rx: Receiver<Job>) {
        let mut engine: Option<Engine> = None;
        while let Ok(job) = rx.recv() {
            if engine.is_none() {
                match Engine::load() {
                    Ok(e) => engine = Some(e),
                    Err(msg) => {
                        eprintln!("[hydropark::inference] model load failed: {msg}");
                        let _ = job.app.emit(
                            "inference://error",
                            InferenceErrorEvent { session_id: job.args.session_id.clone(), message: msg },
                        );
                        continue; // leave engine None so a later job can retry (e.g. model appears)
                    }
                }
            }
            let engine = engine.as_ref().expect("engine loaded above");
            run_job(engine, job);
        }
    }

    // ---- per-generation decode loop -------------------------------------

    pub struct GenStats {
        pub n_decoded: u64,
        pub elapsed_ms: f64,
        pub cancelled: bool,
    }

    /// Builds the Qwen2.5 ChatML prompt. `str_to_token(.., special=true)` maps the
    /// `<|im_start|>` / `<|im_end|>` literals to their real control-token ids.
    pub fn build_chatml_prompt(user_message: &str, skill_enabled: bool) -> String {
        let system = if skill_enabled {
            concat!(
                "You are Hydropark, a friendly offline cooking assistant. The \"Kitchen Timer & Units\" ",
                "skill is enabled, so you can call tools. To call a tool, emit exactly one block of the form:\n",
                "<tool_call>\n{\"name\": \"<tool>\", \"arguments\": { ... }}\n</tool_call>\n\n",
                "Available tools:\n",
                "- start_timer(label: string, duration_sec: integer) — start a kitchen countdown.\n",
                "- convert_units(domain: \"mass\"|\"volume\"|\"temperature\", value: number, from_unit: string, to_unit: string) — convert a quantity.\n",
                "- list_manage(op: \"add\"|\"remove\"|\"check\"|\"uncheck\"|\"set_all\", item?, items?) — edit the ingredient list.\n\n",
                "When the user asks for something a tool can do, respond with ONLY that one <tool_call> ",
                "block and nothing else — no words before or after it, and never write the JSON without ",
                "the <tool_call> and </tool_call> tags around it. Otherwise, just chat normally with no tags.\n\n",
                "If you see a <tool_result> block, that tool ALREADY ran successfully — do not call the ",
                "same tool again with the same arguments, and do not repeat, quote, or paraphrase the raw ",
                "<tool_result> JSON itself. Instead reply with ONE short, plain-language sentence confirming ",
                "what happened for the user, with no tags and no braces. Call each tool AT MOST once per ",
                "request unless the user's request genuinely needs it again with DIFFERENT arguments."
            )
            .to_string()
        } else {
            concat!(
                "You are Hydropark, an offline AI assistant. The \"Kitchen Timer & Units\" skill is NOT ",
                "enabled, so you have no cooking tools. Chat helpfully; if the user wants cooking help, ",
                "suggest they enable the \"Kitchen Timer & Units\" skill."
            )
            .to_string()
        };
        format!(
            "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n",
            system = system,
            user = user_message,
        )
    }

    /// Build the token sampler chain, optionally prepending a GBNF grammar sampler
    /// (P1-02.2 constrained decoding). The grammar sampler masks any token that would
    /// break the two-branch `root ::= tool-call | prose` grammar BEFORE the
    /// distribution samplers pick among what's left. A grammar that fails to
    /// initialize is logged and skipped (decode proceeds unconstrained rather than
    /// aborting the turn).
    fn build_sampler(model: &LlamaModel, grammar: Option<&str>) -> LlamaSampler {
        let temp = temperature();
        let seed = std::env::var("HYDROPARK_SEED")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0xA1B2_C3D4);

        let mut stages: Vec<LlamaSampler> = Vec::new();
        if let Some(g) = grammar {
            // `LlamaSampler::grammar` (llama-cpp-2 `common` feature, default-on) returns
            // `Result<_, GrammarError>`; fall back to unconstrained on a null/invalid grammar.
            match LlamaSampler::grammar(model, g, "root") {
                Ok(s) => stages.push(s),
                Err(e) => eprintln!(
                    "[hydropark::inference] GBNF grammar sampler init failed ({e}); decoding unconstrained"
                ),
            }
        }
        stages.push(LlamaSampler::penalties(64, 1.05, 0.0, 0.0));
        if temp <= 0.0 {
            stages.push(LlamaSampler::greedy());
        } else {
            // Qwen2.5 recommended sampling: top_k=20, top_p=0.8, temp≈0.7, rep pen 1.05.
            stages.push(LlamaSampler::top_k(20));
            stages.push(LlamaSampler::top_p(0.8, 1));
            stages.push(LlamaSampler::temp(temp));
            stages.push(LlamaSampler::dist(seed));
        }
        LlamaSampler::chain_simple(stages)
    }

    /// The core decode loop. Streams decoded UTF-8 pieces to `on_piece`, checks
    /// `is_cancelled` between tokens, applies the optional GBNF `grammar` to the
    /// sampler, and returns timing stats. Free of any Tauri/event coupling so it is
    /// unit-testable without a running app.
    pub fn generate_stream(
        engine: &Engine,
        prompt: &str,
        max_new: usize,
        is_cancelled: &dyn Fn() -> bool,
        grammar: Option<&str>,
        on_piece: &mut dyn FnMut(&str),
    ) -> Result<GenStats, String> {
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx()))
            .with_n_threads(n_threads())
            .with_n_threads_batch(n_threads());
        let mut ctx = engine
            .model
            .new_context(&engine.backend, ctx_params)
            .map_err(|e| format!("failed to create llama context: {e}"))?;

        let tokens = engine
            .model
            .str_to_token(prompt, AddBos::Never)
            .map_err(|e| format!("tokenization failed: {e}"))?;
        if tokens.is_empty() {
            return Err("prompt tokenized to zero tokens".to_string());
        }

        let mut batch = LlamaBatch::new(tokens.len().max(512), 1);
        let last = tokens.len() as i32 - 1;
        for (i, tok) in tokens.iter().enumerate() {
            batch
                .add(*tok, i as i32, &[0], i as i32 == last)
                .map_err(|e| format!("batch add failed: {e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("prompt decode failed: {e}"))?;

        let mut sampler = build_sampler(&engine.model, grammar);
        let start = Instant::now();
        let mut n_cur = batch.n_tokens();
        let mut n_decoded: u64 = 0;
        let mut utf8_buf: Vec<u8> = Vec::new();
        let mut cancelled = false;

        while n_decoded < max_new as u64 {
            if is_cancelled() {
                cancelled = true;
                break;
            }

            // `LlamaSampler::sample` already accepts the chosen token into every
            // sampler in the chain as part of its own contract ("Sample and
            // accept a token…", `llama-cpp-2` sampling.rs; confirmed against the
            // vendored C source, `llama_sampler_sample` calls
            // `llama_sampler_accept` internally as its last step —
            // llama-cpp-sys-2 0.1.151 `llama.cpp/src/llama-sampler.cpp:870`).
            // A second, explicit `sampler.accept(token)` here fed every token to
            // the GBNF grammar sampler's accept() TWICE, silently desyncing the
            // grammar's internal parse-stack state from the actual generated
            // text after the very first token. For any fixed (non-repeating)
            // grammar literal — e.g. this crate's `"<tool_call>"` opening tag —
            // re-accepting the same already-consumed text a second time is
            // structurally impossible from the (already-advanced) parser state,
            // which collapses `stacks` to zero and crashes the NEXT decode step
            // with `GGML_ASSERT(!stacks.empty())` in llama.cpp's grammar engine
            // (llama-grammar.cpp:940) — an unrecoverable process abort, not a
            // catchable Rust error. Do not re-add the extra accept() call.
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            if engine.model.is_eog_token(token) {
                break;
            }

            if let Ok(bytes) = engine.model.token_to_piece_bytes(token, 64, false, None) {
                utf8_buf.extend_from_slice(&bytes);
            }
            let piece = take_valid_utf8(&mut utf8_buf);
            if !piece.is_empty() {
                on_piece(&piece);
            }

            n_decoded += 1;

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("batch add failed: {e}"))?;
            n_cur += 1;
            ctx.decode(&mut batch).map_err(|e| format!("decode failed: {e}"))?;
        }

        Ok(GenStats { n_decoded, elapsed_ms: start.elapsed().as_secs_f64() * 1000.0, cancelled })
    }

    /// Drains the largest valid-UTF-8 prefix of `buf`, leaving any incomplete trailing
    /// multi-byte sequence for the next token.
    fn take_valid_utf8(buf: &mut Vec<u8>) -> String {
        match std::str::from_utf8(buf) {
            Ok(s) => {
                let out = s.to_string();
                buf.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                let out = String::from_utf8_lossy(&buf[..valid]).into_owned();
                match e.error_len() {
                    Some(bad) => {
                        buf.drain(..valid + bad); // genuinely invalid bytes: drop them
                    }
                    None => {
                        buf.drain(..valid); // incomplete tail: keep it for the next token
                    }
                }
                out
            }
        }
    }

    // ---- the real [`turn::Engine`] + per-turn driver --------------------

    /// The real [`turn::Engine`]: per generation, wraps `turn.rs`'s running prompt in
    /// the Qwen ChatML template, decodes it under the GBNF `grammar`, and classifies
    /// the output via the shared [`parse_generation`]. Accumulates the decoded-token
    /// count + surfaces the first hard decode error / cancellation.
    struct RealEngine<'a> {
        engine: &'a Engine,
        skill_enabled: bool,
        cancel: &'a CancelRegistry,
        session_id: &'a str,
        n_decoded: u64,
        cancelled: bool,
        error: Option<String>,
    }

    impl turn::Engine for RealEngine<'_> {
        fn generate(&mut self, prompt: &str, grammar: &str) -> GenOutput {
            if self.cancelled || self.error.is_some() {
                return GenOutput::Prose(String::new());
            }
            // turn.rs hands us a plain `<user>…</user>` + tool-feedback prompt; wrap it
            // as the user turn of the ChatML template (system persona + tool contract).
            let chatml = build_chatml_prompt(prompt, self.skill_enabled);
            let cancel = self.cancel;
            let session_id = self.session_id;
            let is_cancelled = move || cancel.is_cancelled(session_id);
            let mut full = String::new();
            // Scope the on-piece closure so its `&mut full` borrow is released before we
            // read `full` below (the closure temporary otherwise lives into the match).
            let stats = {
                let result = generate_stream(
                    self.engine,
                    &chatml,
                    max_new_tokens(),
                    &is_cancelled,
                    Some(grammar),
                    &mut |piece: &str| full.push_str(piece),
                );
                match result {
                    Ok(s) => s,
                    Err(msg) => {
                        self.error = Some(msg);
                        return GenOutput::Prose(String::new());
                    }
                }
            };
            self.n_decoded += stats.n_decoded;
            if stats.cancelled {
                self.cancelled = true;
                return GenOutput::Prose(full.trim().to_string());
            }
            // Grammar-constrained ⇒ output is either pure prose or one well-formed tool_call.
            parse_generation(&full)
        }
    }

    /// Drive one job through the turn machine over the real catalog, then surface the
    /// transcript as `inference://*` events (mirrors `mock::run`, minus the async
    /// spawn — this already runs on the dedicated worker thread).
    fn run_job(engine: &Engine, job: Job) {
        let Job { app, state, cancel, args } = job;
        let session_id = args.session_id.clone();
        cancel.clear(&session_id);
        let skill_enabled = matches!(
            args.skill_id,
            Some(SkillId::KitchenTimer) | Some(SkillId::CookingAssistant)
        );

        let start = Instant::now();
        let mut real_engine = RealEngine {
            engine,
            skill_enabled,
            cancel: &cancel,
            session_id: &session_id,
            n_decoded: 0,
            cancelled: false,
            error: None,
        };
        let mut runner = CatalogToolRunner::new(state, app.clone());
        let transcript =
            turn::run_turn(&mut real_engine, &mut runner, &args.user_message, &TurnConfig::default());
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;

        if let Some(msg) = real_engine.error.take() {
            eprintln!("[hydropark::inference] generation error: {msg}");
            let _ = app.emit(
                "inference://error",
                InferenceErrorEvent { session_id: session_id.clone(), message: msg },
            );
            return;
        }
        let n_decoded = real_engine.n_decoded;
        drop(real_engine); // release the &cancel / &session_id borrows before emitting

        let _words = emit_steps(&app, &cancel, &session_id, &transcript);
        eprintln!(
            "[hydropark::inference] session {} — {} model tokens in {:.1} ms",
            session_id, n_decoded, elapsed_ms
        );
        emit_done(&app, &session_id, n_decoded, elapsed_ms);
    }

    // ---- unit tests (require the GGUF + a native llama.cpp build) --------
    // Run explicitly, e.g.:
    //   cargo test --release --features real-inference -- --nocapture
    // They SKIP (rather than fail) if the model file can't be found.
    #[cfg(test)]
    mod tests {
        use super::*;

        /// W02b — pure string-builder regression, no model/GGUF required: the
        /// skill-enabled system prompt must tell the model what to do AFTER a
        /// `<tool_result>` comes back (confirm briefly in prose; never repeat
        /// the tool call or the raw result JSON) — the missing guidance that
        /// let a small model over-call (duplicate timers) and/or echo the raw
        /// fed-back JSON as if it were its own reply.
        #[test]
        fn skill_enabled_system_prompt_guides_post_tool_result_behaviour() {
            let prompt = build_chatml_prompt("start a pasta timer", true);
            assert!(
                prompt.contains("do not call the same tool again"),
                "prompt must tell the model not to re-call an already-executed tool: {prompt}"
            );
            assert!(
                prompt.contains("do not repeat, quote, or paraphrase"),
                "prompt must tell the model not to echo the raw tool_result JSON: {prompt}"
            );
            assert!(
                prompt.contains("<tool_result>"),
                "prompt must reference the <tool_result> feedback tag it's giving guidance about: {prompt}"
            );
        }

        /// The skill-disabled persona has no tools at all, so it gets none of
        /// the tool-result guidance (nothing to guide).
        #[test]
        fn skill_disabled_system_prompt_has_no_tool_call_guidance() {
            let prompt = build_chatml_prompt("hello", false);
            assert!(!prompt.contains("<tool_result>"));
            assert!(!prompt.contains("<tool_call>"));
        }

        fn run_prompt(
            engine: &Engine,
            label: &str,
            user: &str,
            skill: bool,
            max_new: usize,
            grammar: Option<&str>,
        ) -> String {
            let prompt = build_chatml_prompt(user, skill);
            let mut text = String::new();
            let stats =
                generate_stream(engine, &prompt, max_new, &|| false, grammar, &mut |p| text.push_str(p))
                    .expect("generation failed");
            let tps = if stats.elapsed_ms > 0.0 {
                stats.n_decoded as f64 / (stats.elapsed_ms / 1000.0)
            } else {
                0.0
            };
            eprintln!(
                "=== {label} ({} tokens, {:.1} ms, {:.2} tok/s) ===\n{}\n=== END {label} ===",
                stats.n_decoded,
                stats.elapsed_ms,
                tps,
                text.trim()
            );
            assert!(stats.n_decoded > 0, "{label}: expected at least one token");
            text
        }

        // One process-wide Engine (LlamaBackend::init is global): a plain turn, then a
        // GBNF-CONSTRAINED tool-call turn. SKIPs (passes) if the GGUF isn't found.
        #[test]
        fn loads_model_generates_and_constrained_tool_calls() {
            let engine = match Engine::load() {
                Ok(e) => e,
                Err(msg) => {
                    eprintln!("SKIP loads_model_generates_and_constrained_tool_calls: {msg}");
                    return;
                }
            };

            let hello =
                run_prompt(&engine, "PLAIN CHAT", "Say hello in exactly one short sentence.", false, 64, None);
            assert!(!hello.trim().is_empty(), "expected non-empty chat output");

            // P1-02.2: decode under the two-branch grammar built from the fixed catalog.
            let grammar = crate::grammar::tool_call_grammar();
            let tool = run_prompt(
                &engine,
                "CONSTRAINED TOOL CALL",
                "Start a 9 minute timer labelled Pasta.",
                true,
                256,
                Some(grammar.as_str()),
            );
            // Under the grammar the output is either pure prose or exactly one
            // well-formed tool_call block — never malformed.
            match parse_generation(&tool) {
                GenOutput::ToolCall(name, args) => eprintln!("parsed tool_call: {name} {args}"),
                GenOutput::Prose(_) => eprintln!("model chose prose this run"),
                GenOutput::Malformed(m) => panic!("grammar-constrained output was malformed: {m}"),
            }
        }

        /// Regression test for Task 17's `GGML_ASSERT(!stacks.empty())` crash.
        ///
        /// ROOT CAUSE (see the Task 17 report for the full derivation, incl. a
        /// standalone probe of the vendored llama.cpp grammar engine): the old
        /// decode loop called `sampler.sample(..)` — which, per `llama-cpp-2`'s
        /// own doc comment ("Sample and accept a token…") and the vendored C
        /// source (`llama_sampler_sample`, `llama-sampler.cpp:870`, calls
        /// `llama_sampler_accept` on the whole chain as its last step) —
        /// ALREADY accepts the chosen token into the grammar sampler, and THEN
        /// called `sampler.accept(token)` a second time. Every generated token
        /// was fed to the GBNF grammar's parse-stack advance TWICE. For any
        /// fixed (non-repeating) grammar literal this is structurally
        /// impossible from the already-advanced state and collapses the
        /// grammar's stack set to zero, aborting the process on the very next
        /// decode step. This is NOT reachable under `mock-inference` (the mock
        /// engine never touches `LlamaSampler`), so this real-inference test —
        /// several grammar-constrained turns back to back, covering multiple
        /// tools and prompts likely to open with the literal `<tool_call>` tag
        /// — is the regression coverage for it. Before the fix this reliably
        /// hard-aborted the test process (`GGML_ASSERT` -> `abort()`, not a
        /// catchable `Result`) on (or near) the very first constrained turn;
        /// after the fix every turn should complete normally.
        #[test]
        fn constrained_tool_calls_survive_multiple_turns_without_grammar_desync() {
            let engine = match Engine::load() {
                Ok(e) => e,
                Err(msg) => {
                    eprintln!("SKIP constrained_tool_calls_survive_multiple_turns_without_grammar_desync: {msg}");
                    return;
                }
            };

            let grammar = crate::grammar::tool_call_grammar();
            let prompts: &[(&str, &str)] = &[
                ("start_timer", "Start a 9 minute timer labelled Pasta."),
                ("convert_units", "What's 350F in Celsius?"),
                ("list_manage", "Add eggs, milk, and butter to my list."),
                ("date_math", "What date is 3 days after 2026-07-17?"),
            ];
            for (label, user) in prompts {
                let out = run_prompt(&engine, label, user, true, 256, Some(grammar.as_str()));
                match parse_generation(&out) {
                    GenOutput::ToolCall(name, args) => eprintln!("{label}: parsed tool_call: {name} {args}"),
                    GenOutput::Prose(_) => eprintln!("{label}: model chose prose this run"),
                    GenOutput::Malformed(m) => {
                        panic!("{label}: grammar-constrained output was malformed: {m}")
                    }
                }
            }
        }
    }
}
