//! Inference engine seam. Exactly one of the two `#[cfg]`-gated modules
//! below is compiled in, selected by Cargo feature (`Cargo.toml`):
//!
//!  - `mock` (default feature `mock-inference`) — a scripted, deterministic
//!    token stream. No model file, no native inference dependency. This is
//!    what makes `cargo check`/`cargo build` on this crate meaningful even
//!    without a GGUF or a C/C++ toolchain (see client/README.md).
//!  - `real` (feature `real-inference`, NOT wired up — see
//!    `// TODO(P0-02.1)` below) — where the embedded llama.cpp binding
//!    goes once available.
//!
//! Both are meant to speak the *exact* same event vocabulary
//! (`inference://token`, `inference://tool_call_detected`,
//! `inference://tool_call_result`, `inference://tool_call_fallback`,
//! `inference://done`, `inference://error` — see `ipc.rs`), so swapping
//! the feature flag is the only change needed anywhere in the app once a
//! real model is wired up.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use crate::ipc::InferenceStartArgs;

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

/// Extracts and parses a Qwen-native `<tool_call>{"name":…,"arguments":…}</tool_call>`
/// block with a **plain JSON parse** (P0-04.1 — explicitly NOT the
/// production GBNF-constrained decoding of SPEC §8.4; see PHASE0-PLAN §3.3
/// for why that's out of scope for the throwaway prototype). Returns
/// `None` on anything that isn't well-formed JSON, which the caller treats
/// as `FallbackReason::MalformedJson`.
pub fn extract_tool_call(text: &str) -> Option<serde_json::Value> {
    const START: &str = "<tool_call>";
    const END: &str = "</tool_call>";
    let start = text.find(START)? + START.len();
    let end = text[start..].find(END)? + start;
    let json_text = text[start..end].trim();
    serde_json::from_str(json_text).ok()
}

/// Entry point used by `main.rs`'s `inference_start` command. Dispatches
/// to whichever engine is compiled in.
pub fn start(app: AppHandle, state: crate::tools::AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
    #[cfg(feature = "mock-inference")]
    mock::run(app, state, cancel, args);

    #[cfg(feature = "real-inference")]
    real::run(app, state, cancel, args);

    #[cfg(not(any(feature = "mock-inference", feature = "real-inference")))]
    compile_error!("enable either the `mock-inference` or `real-inference` feature");
}

// ---------------------------------------------------------------------------
// Mock engine — scripted, deterministic. MIRRORS
// client/web/src/app/ipc/mock-ipc.service.ts's `scriptTurn()` so the
// Angular-only mock and this Rust mock demonstrate identically, even
// though they never run in the same process.
// ---------------------------------------------------------------------------

#[cfg(feature = "mock-inference")]
pub mod mock {
    use super::*;
    use crate::ipc::{
        FallbackReason, InferenceDoneEvent, InferenceErrorEvent, InferenceToolCallDetectedEvent,
        InferenceToolCallFallbackEvent, InferenceToolCallResultEvent, InferenceTokenEvent,
        SkillId, ToolName,
    };
    use crate::tools::{self, AppState};
    use std::time::Duration;
    use tauri::Emitter;
    use tokio::time::sleep;

    enum Step {
        Text(&'static str),
        ToolCallValid { tool: ToolName, args: serde_json::Value },
        ToolCallMalformed(&'static str),
    }

    fn script_turn(user_message: &str, skill_enabled: bool) -> Vec<Step> {
        let msg = user_message.to_lowercase();

        if !skill_enabled {
            return vec![Step::Text(
                "I'm the base Hydropark agent — I can chat, but I don't have cooking tools yet. \
                 Enable \"Kitchen Timer & Units\" and ask me again.",
            )];
        }
        if msg.contains("confuse") || msg.contains("gibberish") {
            return vec![
                Step::Text("Hmm, let me think about how to help with that."),
                Step::ToolCallMalformed("<tool_call>{not valid json at all"),
            ];
        }
        if msg.contains("unknown tool") || msg.contains("random tool") {
            return vec![
                Step::Text("One moment —"),
                Step::ToolCallMalformed(
                    r#"<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>"#,
                ),
            ];
        }
        if msg.contains("surprise") {
            return vec![
                Step::Text("Sure, let me set that up for you —"),
                Step::ToolCallMalformed(
                    r#"<tool_call>{"name":"start_timer","arguments":{"label":"Mystery"}}</tool_call>"#,
                ),
                Step::Text("I've prefilled a timer below — just tell me how long to set it for."),
            ];
        }
        if msg.contains("carbonara") {
            return vec![
                Step::Text("Great choice! Let's cook carbonara for 4. Here's what you'll need —"),
                Step::ToolCallValid {
                    tool: ToolName::ListManage,
                    args: serde_json::json!({
                        "op": "set_all",
                        "items": [
                            {"name": "Spaghetti", "qty": 400.0, "unit": "g"},
                            {"name": "Guanciale (or pancetta)", "qty": 150.0, "unit": "g"},
                            {"name": "Egg yolks", "qty": 4.0},
                            {"name": "Whole egg", "qty": 1.0},
                            {"name": "Pecorino Romano, grated", "qty": 50.0, "unit": "g"},
                            {"name": "Black pepper"}
                        ]
                    }),
                },
                Step::Text(
                    "I've filled in the ingredient list — flip US/Metric anytime, it re-converts \
                     exactly. Starting the pasta timer now —",
                ),
                Step::ToolCallValid {
                    tool: ToolName::StartTimer,
                    args: serde_json::json!({"label": "Pasta", "duration_sec": 540}),
                },
                Step::Text(
                    "Pasta timer is running (9:00). I'll ping you when it's done — want a sauce timer too?",
                ),
            ];
        }
        vec![Step::Text(
            "Kitchen Timer & Units is on — try \"Help me cook carbonara for 4\", or use the panels directly.",
        )]
    }

    /// Splits on whitespace runs while keeping them as their own tokens,
    /// so streamed output reproduces natural spacing — equivalent to the
    /// TS mock's `text.split(/(\s+)/).filter(w => w.length > 0)`.
    fn split_keep_whitespace(text: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut start = 0;
        let mut chars = text.char_indices().peekable();
        let mut in_space = text.starts_with(char::is_whitespace);
        while let Some((i, c)) = chars.next() {
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

    fn classify_malformed(
        parsed: Option<serde_json::Value>,
    ) -> (Option<ToolName>, Option<serde_json::Value>, FallbackReason) {
        let Some(value) = parsed else {
            return (None, None, FallbackReason::MalformedJson);
        };
        let name = value.get("name").and_then(|n| n.as_str());
        let arguments = value.get("arguments").cloned();
        match name {
            Some("start_timer") => (Some(ToolName::StartTimer), arguments, FallbackReason::InvalidArgs),
            Some("convert_units") => (Some(ToolName::ConvertUnits), arguments, FallbackReason::InvalidArgs),
            Some("list_manage") => (Some(ToolName::ListManage), arguments, FallbackReason::InvalidArgs),
            _ => (None, arguments, FallbackReason::UnknownTool),
        }
    }

    pub fn run(app: AppHandle, state: AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
        tauri::async_runtime::spawn(async move {
            let session_id = args.session_id.clone();
            cancel.clear(&session_id);
            let skill_enabled = matches!(
                args.skill_id,
                Some(SkillId::KitchenTimerUnits) | Some(SkillId::CookingAssistant)
            );
            let steps = script_turn(&args.user_message, skill_enabled);
            let start_time = std::time::Instant::now();
            let mut seq: u64 = 0;
            let mut token_count: u64 = 0;

            'steps: for step in steps {
                if cancel.is_cancelled(&session_id) {
                    break;
                }
                match step {
                    Step::Text(text) => {
                        for word in split_keep_whitespace(text) {
                            if cancel.is_cancelled(&session_id) {
                                break 'steps;
                            }
                            sleep(Duration::from_millis(18 + (seq % 24) * 2)).await;
                            token_count += 1;
                            let _ = app.emit(
                                "inference://token",
                                InferenceTokenEvent { session_id: session_id.clone(), seq, token: word.to_string() },
                            );
                            seq += 1;
                        }
                    }
                    Step::ToolCallValid { tool, args: tool_args } => {
                        sleep(Duration::from_millis(120)).await;
                        let raw = format!(
                            "<tool_call>{{\"name\":\"{tool}\",\"arguments\":{tool_args}}}</tool_call>"
                        );
                        let _ = app.emit(
                            "inference://tool_call_detected",
                            InferenceToolCallDetectedEvent {
                                session_id: session_id.clone(),
                                raw,
                                tool: Some(tool),
                                parsed_args: Some(tool_args.clone()),
                                valid: true,
                            },
                        );
                        match tools::validate_and_parse(tool, &tool_args) {
                            Ok(typed) => match tools::execute(&state, &app, typed) {
                                Ok((executed_tool, result)) => {
                                    let _ = app.emit(
                                        "inference://tool_call_result",
                                        InferenceToolCallResultEvent {
                                            session_id: session_id.clone(),
                                            tool: executed_tool,
                                            result,
                                        },
                                    );
                                }
                                Err(e) => {
                                    let _ = app.emit(
                                        "inference://error",
                                        InferenceErrorEvent { session_id: session_id.clone(), message: e.to_string() },
                                    );
                                }
                            },
                            Err(e) => {
                                let _ = app.emit(
                                    "inference://error",
                                    InferenceErrorEvent { session_id: session_id.clone(), message: e.to_string() },
                                );
                            }
                        }
                    }
                    Step::ToolCallMalformed(raw) => {
                        sleep(Duration::from_millis(120)).await;
                        let parsed = extract_tool_call(raw);
                        let (tool, parsed_args, reason) = classify_malformed(parsed);
                        let _ = app.emit(
                            "inference://tool_call_detected",
                            InferenceToolCallDetectedEvent {
                                session_id: session_id.clone(),
                                raw: raw.to_string(),
                                tool,
                                parsed_args: parsed_args.clone(),
                                valid: false,
                            },
                        );
                        let clarifying_question = if tool.is_none() {
                            Some(
                                "Could you tell me what you would like me to do — start a timer, \
                                 update the ingredient list, or convert a unit?"
                                    .to_string(),
                            )
                        } else {
                            None
                        };
                        let _ = app.emit(
                            "inference://tool_call_fallback",
                            InferenceToolCallFallbackEvent {
                                session_id: session_id.clone(),
                                reason,
                                tool,
                                parsed_args,
                                clarifying_question,
                            },
                        );
                    }
                }
            }

            let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
            let tok_per_sec = if token_count > 0 {
                (token_count as f64) / (elapsed_ms / 1000.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "inference://done",
                InferenceDoneEvent {
                    session_id: session_id.clone(),
                    tokens_generated: token_count,
                    elapsed_ms,
                    tok_per_sec: (tok_per_sec * 10.0).round() / 10.0,
                },
            );
        });
    }
}

// ---------------------------------------------------------------------------
// Real engine — NOT implemented. This is the seam, not the binding.
// ---------------------------------------------------------------------------

// TODO(P0-02.1): embed llama.cpp and load `qwen2.5-3b-instruct-q4_k_m`
// in-process here. Candidate crate: `llama-cpp-2` (safe bindings, supports
// GBNF grammars for whenever P0-04.3a's contingent grammar work lands) or
// `llama_cpp`. Concretely, this module should:
//   1. In `main.rs`'s `.setup()`, load the GGUF once into a `State<Model>`
//      (model load is slow; do it at startup with a progress event, not
//      per-turn).
//   2. In `run()` below, assemble the prompt per SPEC §8.3.1–§8.3.2 (base
//      preamble + primary skill's `system_prompt` + secondary
//      `compressed_prompt`s + transcript) and feed it through the loaded
//      context, streaming tokens via `app.emit("inference://token", …)` —
//      the exact same event the mock module emits, so nothing downstream
//      (ipc.rs, tools.rs, or any Angular code) needs to change.
//   3. Watch the stream for a `<tool_call>…</tool_call>` block using
//      `extract_tool_call` above (Phase 0 explicitly does NOT add
//      GBNF-constrained decoding unless P0-07.3's pure-model pass shows
//      Qwen can't reliably emit clean tool JSON — PHASE0-PLAN §3.3 /
//      ticket P0-04.3a). On finding one, validate via
//      `tools::validate_and_parse` and execute/fallback exactly like the
//      mock module does.
//   4. Respect `CancelRegistry` between tokens so `inference_cancel`
//      actually interrupts generation (P0-02.2 AC).
//
// This module is intentionally left compiling-but-unimplemented (rather
// than commented out) so `cargo build --features real-inference` fails
// loudly at *run*time with a clear message instead of not existing at
// all — a future implementer flips the `real-inference` feature in
// Cargo.toml to pull in `llama-cpp-2` and replaces the body below.
#[cfg(feature = "real-inference")]
pub mod real {
    use super::*;

    pub fn run(_app: AppHandle, _state: crate::tools::AppState, _cancel: CancelRegistry, _args: InferenceStartArgs) {
        unimplemented!(
            "P0-02.1: embed llama.cpp (llama-cpp-2) and load qwen2.5-3b-instruct-q4_k_m here; \
             see the doc comment above this module."
        )
    }
}
