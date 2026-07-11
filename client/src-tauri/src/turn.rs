#![allow(dead_code)] // Phase-1 turn state machine; wired into inference.rs in a later ticket.

//! The turn state machine (P1-02.3/.4, SPEC §8.4).
//!
//! One user message drives one *turn*: the model generates, and if it emits a
//! tool call the machine validates it against the fixed [`crate::tool_catalog`],
//! executes it, feeds the structured result back, and lets the model continue —
//! up to a bounded number of tool hops. The lifecycle is:
//!
//!   generate → (prose ⇒ done)
//!            → (tool_call ⇒ validate against the catalog)
//!                 → valid   ⇒ execute via [`ToolRunner`], feed result back, continue
//!                 → invalid ⇒ ONE repair re-prompt
//!                              → valid   ⇒ execute, continue
//!                              → prose   ⇒ done
//!                              → invalid ⇒ graceful fallback (widget / clarifying Q), done
//!
//! A structured tool-execution error is **surfaced and fed back**, never
//! silently swallowed (SPEC §8.4 pt 4): it is recorded as a [`Step::ToolError`]
//! and pushed into the model's context so the model must acknowledge it.
//!
//! The machine is defined over two abstract traits — [`Engine`] and
//! [`ToolRunner`] — so it is fully unit-testable with scripted fakes: pure
//! logic, no real model, no network, no IO. The graceful-fallback surface reuses
//! the meaning of [`crate::ipc::FallbackReason`] (malformed JSON / unknown tool /
//! invalid args) that both Phase-0 engines already emit.
//!
//! NOTE (integration is a later step): the real hook-up — feeding
//! [`crate::grammar::tool_call_grammar`] to the llama sampler and driving this
//! machine from `inference.rs` (emitting the `inference://*` events) — is a
//! later real-inference integration ticket. This tranche builds and unit-tests
//! the turn logic against fake engines/runners.

use serde_json::Value;

use crate::ipc::FallbackReason;
use crate::tool_catalog::{self, ToolError, ToolName, TypedArgs};

/// One unit of model output the [`Engine`] hands back per generation.
#[derive(Debug, Clone, PartialEq)]
pub enum GenOutput {
    /// Free assistant chat text (the prose branch of the grammar).
    Prose(String),
    /// A tool call: the JSON `name` and its `arguments` object (not yet validated).
    ToolCall(String, Value),
    /// Output that could not be parsed as a tool call (e.g. broken JSON).
    Malformed(String),
}

/// The model seam. Given the running prompt and the constrained-decoding
/// grammar, produce the next [`GenOutput`]. Abstract so the machine is testable
/// without a model (the real impl wraps the llama engine + GBNF sampler).
pub trait Engine {
    fn generate(&mut self, prompt: &str, grammar: &str) -> GenOutput;
}

/// A structured tool-execution failure. Distinct from a *validation* failure
/// (which never reaches the runner): the tool was well-formed and dispatched,
/// but running it failed. Must be acknowledged, never swallowed (SPEC §8.4 pt 4).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ToolExecError {
    #[error("tool '{tool}' failed to execute: {reason}")]
    Failed { tool: ToolName, reason: String },
}

impl ToolExecError {
    pub fn failed(tool: ToolName, reason: impl Into<String>) -> Self {
        Self::Failed { tool, reason: reason.into() }
    }
}

/// The tool-execution seam. Runs a validated, typed call and returns its
/// structured result, or a [`ToolExecError`]. Abstract so the machine is
/// testable without the real Tool Runtime / `AppState`.
pub trait ToolRunner {
    fn run(&mut self, name: ToolName, args: &TypedArgs) -> Result<Value, ToolExecError>;
}

/// Per-turn limits.
#[derive(Debug, Clone, Copy)]
pub struct TurnConfig {
    /// Maximum number of tool executions in a single turn (SPEC §8.4 bounded
    /// hops). A further tool call past the cap ends the turn ([`Step::HopLimitReached`]).
    pub max_tool_hops: usize,
}

impl Default for TurnConfig {
    fn default() -> Self {
        Self { max_tool_hops: 4 }
    }
}

/// The graceful-fallback surface produced when a tool call is still invalid
/// after the one repair attempt. Mirrors [`crate::ipc::InferenceToolCallFallbackEvent`]:
/// when the tool is known, surface its bound widget (prefilled with
/// `parsed_args`); otherwise post one clarifying question to chat.
#[derive(Debug, Clone, PartialEq)]
pub struct Fallback {
    pub reason: FallbackReason,
    pub tool: Option<ToolName>,
    pub parsed_args: Option<Value>,
    pub clarifying_question: Option<String>,
}

/// One recorded step in a turn's transcript (the machine's return value).
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// The model produced final chat text.
    Prose(String),
    /// A validated tool call about to be executed.
    ToolCall { tool: ToolName, args: Value },
    /// A successful tool execution's structured result (fed back to the model).
    ToolResult { tool: ToolName, result: Value },
    /// A structured tool-execution error (surfaced AND fed back — never swallowed).
    ToolError { tool: ToolName, error: ToolExecError },
    /// A single repair re-prompt was triggered by an invalid/malformed call.
    RepairAttempt { reason: FallbackReason, tool: Option<ToolName>, raw: String },
    /// The turn degraded gracefully after repair still failed.
    Fallback(Fallback),
    /// The bounded tool-hop cap was hit; the turn ends.
    HopLimitReached { limit: usize },
}

/// The ordered record of everything that happened in a turn.
#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub steps: Vec<Step>,
}

impl Transcript {
    /// Number of tool calls that were executed (or attempted at the runner).
    pub fn tool_calls(&self) -> usize {
        self.steps.iter().filter(|s| matches!(s, Step::ToolCall { .. })).count()
    }

    /// Number of structured tool-execution errors surfaced.
    pub fn tool_errors(&self) -> usize {
        self.steps.iter().filter(|s| matches!(s, Step::ToolError { .. })).count()
    }

    /// Number of repair re-prompts triggered.
    pub fn repairs(&self) -> usize {
        self.steps.iter().filter(|s| matches!(s, Step::RepairAttempt { .. })).count()
    }

    /// The graceful fallback, if the turn ended in one.
    pub fn fallback(&self) -> Option<&Fallback> {
        self.steps.iter().find_map(|s| match s {
            Step::Fallback(f) => Some(f),
            _ => None,
        })
    }

    /// The last prose the model produced, if any.
    pub fn final_prose(&self) -> Option<&str> {
        self.steps.iter().rev().find_map(|s| match s {
            Step::Prose(t) => Some(t.as_str()),
            _ => None,
        })
    }

    /// Whether the turn ended by hitting the tool-hop cap.
    pub fn hit_hop_limit(&self) -> bool {
        self.steps.iter().any(|s| matches!(s, Step::HopLimitReached { .. }))
    }
}

/// Drive one turn to completion, returning its transcript.
///
/// The constrained-decoding grammar is built once from the fixed catalog and
/// passed to every generation, so the model can only ever decode a catalog tool.
pub fn run_turn<E: Engine, R: ToolRunner>(
    engine: &mut E,
    runner: &mut R,
    user_message: &str,
    config: &TurnConfig,
) -> Transcript {
    let grammar = crate::grammar::tool_call_grammar();
    let mut ctx = TurnContext::new(user_message);
    let mut steps: Vec<Step> = Vec::new();
    let mut hops: usize = 0;

    loop {
        let out = engine.generate(&ctx.prompt(), &grammar);
        match interpret(out) {
            Interpreted::Prose(text) => {
                steps.push(Step::Prose(text));
                break;
            }
            Interpreted::Valid { tool, args, typed } => {
                match execute_validated(
                    runner, tool, args, typed, &mut steps, &mut ctx, &mut hops, config,
                ) {
                    Flow::Continue => continue,
                    Flow::Stop => break,
                }
            }
            Interpreted::Invalid { reason, tool, raw, .. } => {
                // ONE repair re-prompt (SPEC §8.4). Record that we tried.
                steps.push(Step::RepairAttempt { reason, tool, raw: raw.clone() });
                ctx.push_repair(&raw);

                let repaired = engine.generate(&ctx.prompt(), &grammar);
                match interpret(repaired) {
                    Interpreted::Prose(text) => {
                        steps.push(Step::Prose(text));
                        break;
                    }
                    Interpreted::Valid { tool, args, typed } => {
                        match execute_validated(
                            runner, tool, args, typed, &mut steps, &mut ctx, &mut hops, config,
                        ) {
                            Flow::Continue => continue,
                            Flow::Stop => break,
                        }
                    }
                    Interpreted::Invalid { reason, tool, parsed_args, .. } => {
                        // Still invalid after the single repair: degrade gracefully.
                        steps.push(Step::Fallback(build_fallback(reason, tool, parsed_args)));
                        break;
                    }
                }
            }
        }
    }

    Transcript { steps }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

enum Flow {
    Continue,
    Stop,
}

/// A [`GenOutput`] resolved against the fixed catalog.
enum Interpreted {
    Prose(String),
    Valid { tool: ToolName, args: Value, typed: TypedArgs },
    Invalid { reason: FallbackReason, tool: Option<ToolName>, parsed_args: Option<Value>, raw: String },
}

/// Classify one generation against the catalog: prose passes through; a tool
/// call is validated (name in catalog + args parse) into `Valid`; anything else
/// becomes `Invalid` carrying the [`FallbackReason`] the fallback surface needs.
fn interpret(out: GenOutput) -> Interpreted {
    match out {
        GenOutput::Prose(text) => Interpreted::Prose(text),
        GenOutput::Malformed(raw) => Interpreted::Invalid {
            reason: FallbackReason::MalformedJson,
            tool: None,
            parsed_args: None,
            raw,
        },
        GenOutput::ToolCall(name, args) => match tool_catalog::validate_and_parse(&name, &args) {
            Ok(typed) => Interpreted::Valid { tool: typed.tool(), args, typed },
            Err(ToolError::UnknownTool { .. }) => Interpreted::Invalid {
                reason: FallbackReason::UnknownTool,
                tool: None, // not in the audited catalog: no bound widget to surface
                parsed_args: Some(args.clone()),
                raw: raw_of(&name, &args),
            },
            Err(ToolError::InvalidArgs { .. }) | Err(ToolError::ExecutionFailed { .. }) => {
                Interpreted::Invalid {
                    reason: FallbackReason::InvalidArgs,
                    tool: tool_catalog::lookup(&name), // known tool: its widget can be prefilled
                    parsed_args: Some(args.clone()),
                    raw: raw_of(&name, &args),
                }
            }
        },
    }
}

/// Execute a validated call: enforce the hop cap, run it, and record + feed back
/// either the result or the structured error.
#[allow(clippy::too_many_arguments)]
fn execute_validated<R: ToolRunner>(
    runner: &mut R,
    tool: ToolName,
    args: Value,
    typed: TypedArgs,
    steps: &mut Vec<Step>,
    ctx: &mut TurnContext,
    hops: &mut usize,
    config: &TurnConfig,
) -> Flow {
    if *hops >= config.max_tool_hops {
        steps.push(Step::HopLimitReached { limit: config.max_tool_hops });
        return Flow::Stop;
    }
    *hops += 1;
    steps.push(Step::ToolCall { tool, args });

    match runner.run(tool, &typed) {
        Ok(result) => {
            ctx.push_result(tool, &result);
            steps.push(Step::ToolResult { tool, result });
        }
        Err(error) => {
            // SPEC §8.4 pt 4: surface AND feed back, so the model must acknowledge.
            ctx.push_error(tool, &error);
            steps.push(Step::ToolError { tool, error });
        }
    }
    Flow::Continue
}

/// The graceful-fallback surface: prefill the tool's widget when the tool is
/// known, otherwise ask one clarifying question (mirrors both Phase-0 engines).
fn build_fallback(
    reason: FallbackReason,
    tool: Option<ToolName>,
    parsed_args: Option<Value>,
) -> Fallback {
    let clarifying_question = if tool.is_none() {
        Some(
            "Could you tell me what you would like me to do - start a timer, update a list, \
             convert a unit, run a calculation, or do a date calculation?"
                .to_string(),
        )
    } else {
        None
    };
    Fallback { reason, tool, parsed_args, clarifying_question }
}

/// Reconstruct the raw `<tool_call>` JSON payload for the transcript.
fn raw_of(name: &str, args: &Value) -> String {
    serde_json::json!({ "name": name, "arguments": args }).to_string()
}

/// The running turn context fed to the model each hop. Kept deliberately simple:
/// the user message plus a running log of tool results / errors / repair notes,
/// so tool outputs are demonstrably *fed back* into subsequent generations.
struct TurnContext {
    user_message: String,
    feedback: Vec<String>,
}

impl TurnContext {
    fn new(user_message: &str) -> Self {
        Self { user_message: user_message.to_string(), feedback: Vec::new() }
    }

    fn prompt(&self) -> String {
        let mut p = format!("<user>\n{}\n</user>", self.user_message);
        for f in &self.feedback {
            p.push('\n');
            p.push_str(f);
        }
        p
    }

    fn push_result(&mut self, tool: ToolName, result: &Value) {
        self.feedback
            .push(format!("<tool_result tool=\"{}\">{}</tool_result>", tool.as_ref_str(), result));
    }

    fn push_error(&mut self, tool: ToolName, error: &ToolExecError) {
        self.feedback
            .push(format!("<tool_error tool=\"{}\">{}</tool_error>", tool.as_ref_str(), error));
    }

    fn push_repair(&mut self, raw: &str) {
        self.feedback
            .push(format!("<repair>the previous tool call was invalid: {raw}</repair>"));
    }
}

// ---------------------------------------------------------------------------
// Tests — fully scripted fakes; pure logic, no model, no IO.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// An [`Engine`] that replays a fixed script of outputs. When `repeat_last`
    /// is set and the script is exhausted, it keeps returning the final output
    /// (used to probe the hop cap).
    struct ScriptEngine {
        outputs: Vec<GenOutput>,
        idx: usize,
        repeat_last: bool,
    }

    impl ScriptEngine {
        fn new(outputs: Vec<GenOutput>) -> Self {
            Self { outputs, idx: 0, repeat_last: false }
        }
        fn repeating(output: GenOutput) -> Self {
            Self { outputs: vec![output], idx: 0, repeat_last: true }
        }
    }

    impl Engine for ScriptEngine {
        fn generate(&mut self, _prompt: &str, _grammar: &str) -> GenOutput {
            if self.idx < self.outputs.len() {
                let out = self.outputs[self.idx].clone();
                self.idx += 1;
                out
            } else if self.repeat_last && !self.outputs.is_empty() {
                self.outputs[self.outputs.len() - 1].clone()
            } else {
                panic!("scripted engine exhausted");
            }
        }
    }

    /// A [`ToolRunner`] that always succeeds, echoing which tool ran.
    struct OkRunner;
    impl ToolRunner for OkRunner {
        fn run(&mut self, name: ToolName, _args: &TypedArgs) -> Result<Value, ToolExecError> {
            Ok(json!({ "ok": true, "tool": name.as_ref_str() }))
        }
    }

    /// A [`ToolRunner`] that always fails with a structured error.
    struct ErrRunner;
    impl ToolRunner for ErrRunner {
        fn run(&mut self, name: ToolName, _args: &TypedArgs) -> Result<Value, ToolExecError> {
            Err(ToolExecError::failed(name, "simulated hardware failure"))
        }
    }

    fn valid_timer_call() -> GenOutput {
        GenOutput::ToolCall("start_timer".to_string(), json!({ "label": "Pasta", "duration_sec": 540 }))
    }

    // (a) prose-only happy path
    #[test]
    fn prose_only_happy_path() {
        let mut engine = ScriptEngine::new(vec![GenOutput::Prose("Hi there!".to_string())]);
        let mut runner = OkRunner;
        let t = run_turn(&mut engine, &mut runner, "hello", &TurnConfig::default());
        assert_eq!(t.tool_calls(), 0);
        assert_eq!(t.repairs(), 0);
        assert!(t.fallback().is_none());
        assert_eq!(t.final_prose(), Some("Hi there!"));
    }

    // (b) valid tool_call -> exec -> prose
    #[test]
    fn valid_tool_call_executes_then_prose() {
        let mut engine = ScriptEngine::new(vec![
            valid_timer_call(),
            GenOutput::Prose("Your pasta timer is running.".to_string()),
        ]);
        let mut runner = OkRunner;
        let t = run_turn(&mut engine, &mut runner, "set a pasta timer", &TurnConfig::default());
        assert_eq!(t.tool_calls(), 1);
        assert_eq!(t.tool_errors(), 0);
        assert!(t.steps.iter().any(|s| matches!(s, Step::ToolResult { tool: ToolName::StartTimer, .. })));
        assert_eq!(t.final_prose(), Some("Your pasta timer is running."));
    }

    // (c) malformed -> repair -> valid
    #[test]
    fn malformed_then_repair_to_valid() {
        let mut engine = ScriptEngine::new(vec![
            GenOutput::Malformed("<tool_call>{not valid json".to_string()),
            valid_timer_call(),
            GenOutput::Prose("Done.".to_string()),
        ]);
        let mut runner = OkRunner;
        let t = run_turn(&mut engine, &mut runner, "set a timer", &TurnConfig::default());
        assert_eq!(t.repairs(), 1);
        assert_eq!(t.tool_calls(), 1);
        assert!(t.fallback().is_none());
        assert_eq!(t.final_prose(), Some("Done."));
    }

    // (d) malformed -> repair -> still malformed -> fallback
    #[test]
    fn malformed_then_repair_still_malformed_falls_back() {
        let mut engine = ScriptEngine::new(vec![
            GenOutput::Malformed("<tool_call>{oops".to_string()),
            GenOutput::Malformed("<tool_call>{still broken".to_string()),
        ]);
        let mut runner = OkRunner;
        let t = run_turn(&mut engine, &mut runner, "do a thing", &TurnConfig::default());
        assert_eq!(t.repairs(), 1);
        assert_eq!(t.tool_calls(), 0);
        let fb = t.fallback().expect("a graceful fallback");
        assert_eq!(fb.reason, FallbackReason::MalformedJson);
        assert!(fb.tool.is_none());
        assert!(fb.clarifying_question.is_some(), "unknown tool -> ask a clarifying question");
    }

    // (e) hop cap enforced
    #[test]
    fn hop_cap_is_enforced() {
        let mut engine = ScriptEngine::repeating(valid_timer_call());
        let mut runner = OkRunner;
        let cfg = TurnConfig { max_tool_hops: 4 };
        let t = run_turn(&mut engine, &mut runner, "loop", &cfg);
        assert_eq!(t.tool_calls(), 4, "exactly max_tool_hops executions");
        assert!(t.hit_hop_limit());
    }

    // SPEC §8.4 pt 4: a tool-exec error is surfaced and fed back, not swallowed.
    #[test]
    fn tool_exec_error_is_surfaced_and_fed_back() {
        let mut engine = ScriptEngine::new(vec![
            valid_timer_call(),
            GenOutput::Prose("Sorry - the timer couldn't start.".to_string()),
        ]);
        let mut runner = ErrRunner;
        let t = run_turn(&mut engine, &mut runner, "start timer", &TurnConfig::default());
        assert_eq!(t.tool_errors(), 1);
        assert!(t.steps.iter().any(|s| matches!(s, Step::ToolError { tool: ToolName::StartTimer, .. })));
        // the model got the error back and acknowledged it in prose.
        assert_eq!(t.final_prose(), Some("Sorry - the timer couldn't start."));
    }

    // invalid-args fallback prefills the bound widget (known tool, no question).
    #[test]
    fn invalid_args_fallback_prefills_the_bound_widget() {
        let bad = || GenOutput::ToolCall("start_timer".to_string(), json!({ "label": "" }));
        let mut engine = ScriptEngine::new(vec![bad(), bad()]);
        let mut runner = OkRunner;
        let t = run_turn(&mut engine, &mut runner, "timer", &TurnConfig::default());
        assert_eq!(t.repairs(), 1);
        let fb = t.fallback().expect("a graceful fallback");
        assert_eq!(fb.reason, FallbackReason::InvalidArgs);
        assert_eq!(fb.tool, Some(ToolName::StartTimer));
        assert!(fb.parsed_args.is_some(), "known tool -> prefill the widget");
        assert!(fb.clarifying_question.is_none());
    }

    // unknown-tool fallback asks a clarifying question (no widget to prefill).
    #[test]
    fn unknown_tool_falls_back_to_a_clarifying_question() {
        let unk = || GenOutput::ToolCall("delete_everything".to_string(), json!({}));
        let mut engine = ScriptEngine::new(vec![unk(), unk()]);
        let mut runner = OkRunner;
        let t = run_turn(&mut engine, &mut runner, "nuke it", &TurnConfig::default());
        let fb = t.fallback().expect("a graceful fallback");
        assert_eq!(fb.reason, FallbackReason::UnknownTool);
        assert!(fb.tool.is_none());
        assert!(fb.clarifying_question.is_some());
    }

    // a repair that yields prose ends the turn cleanly (no fallback).
    #[test]
    fn repair_yielding_prose_ends_the_turn() {
        let mut engine = ScriptEngine::new(vec![
            GenOutput::Malformed("<tool_call>{broken".to_string()),
            GenOutput::Prose("Let me just answer directly instead.".to_string()),
        ]);
        let mut runner = OkRunner;
        let t = run_turn(&mut engine, &mut runner, "help", &TurnConfig::default());
        assert_eq!(t.repairs(), 1);
        assert!(t.fallback().is_none());
        assert_eq!(t.final_prose(), Some("Let me just answer directly instead."));
    }
}
