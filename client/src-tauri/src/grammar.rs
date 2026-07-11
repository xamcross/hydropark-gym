#![allow(dead_code)] // Phase-1 GBNF builder; applied to the real engine in a later ticket.

//! GBNF grammar builder for constrained tool-call decoding (P1-02.2, SPEC §8.4).
//!
//! Produces a **two-branch** GBNF grammar whose `root` is `prose | one tool_call`:
//! either the assistant emits free chat text, or it emits exactly one
//! `<tool_call>{ "name": …, "arguments": { … } }</tool_call>` block whose `name`
//! is one of the fixed [`crate::tool_catalog`] tool refs and whose `arguments`
//! object is constrained to that tool's typed shape. It is a **pure string
//! builder** — no model, no IO — driven entirely off the fixed catalog, so the
//! grammar cannot name a tool that isn't in the audited set.
//!
//! NOTE (integration is a later step): *applying* this GBNF string to the real
//! llama.cpp engine (feeding it to the sampler) and wiring the turn loop
//! ([`crate::turn`]) into `inference.rs` is a later real-inference integration
//! ticket. This tranche builds and unit-tests the grammar string itself; the
//! only guarantees asserted here are structural (mentions every tool name,
//! non-empty, deterministic for a given catalog).

use crate::tool_catalog::ToolName;

const HEADER: &str = "\
# Hydropark tool-call GBNF (P1-02.2) - two-branch root: prose | one tool_call.
# Generated from the fixed tool_catalog; do not hand-edit.

";

/// Build the constrained-decoding grammar for the full, fixed tool catalog.
pub fn tool_call_grammar() -> String {
    build_grammar(&ToolName::ALL)
}

/// Build the grammar for an explicit tool set (the catalog order is
/// deterministic, so the output is stable for a given `tools` slice). Every
/// tool's `-call` rule is emitted, and the `call` alternation lists exactly the
/// tools passed in — so a subset grammar can never decode to an excluded tool.
pub fn build_grammar(tools: &[ToolName]) -> String {
    let call_alternation = tools
        .iter()
        .map(|t| tool_call_rule_name(*t))
        .collect::<Vec<_>>()
        .join(" | ");

    let mut out = String::new();
    out.push_str(HEADER);
    out.push_str("root ::= tool-call | prose\n");
    out.push_str("tool-call ::= \"<tool_call>\" ws call ws \"</tool_call>\"\n");
    out.push_str("call ::= ");
    out.push_str(&call_alternation);
    out.push_str("\n\n");

    for &t in tools {
        out.push_str(per_tool_block(t));
        out.push('\n');
    }

    out.push_str(PRIMITIVES);
    out
}

/// The GBNF rule name for a tool's `<tool_call>` shape. Rule names use hyphens
/// (llama.cpp's grammar parser treats `_` as a non-word char), while the JSON
/// `name` literal inside the rule keeps the exact snake_case ref.
fn tool_call_rule_name(t: ToolName) -> String {
    format!("{}-call", t.as_ref_str().replace('_', "-"))
}

/// The self-contained GBNF block (call rule + args rule + any tool-local enum
/// rules) for one catalog tool. Shared primitives (`ws`, `string`, `number`,
/// `integer`, `boolean`, `unit-id`) live in [`PRIMITIVES`] and are emitted once.
fn per_tool_block(t: ToolName) -> &'static str {
    match t {
        ToolName::StartTimer => START_TIMER_BLOCK,
        ToolName::ConvertUnits => CONVERT_UNITS_BLOCK,
        ToolName::ListManage => LIST_MANAGE_BLOCK,
        ToolName::Calculate => CALCULATE_BLOCK,
        ToolName::DateMath => DATE_MATH_BLOCK,
    }
}

const START_TIMER_BLOCK: &str = r#"# start_timer(label, duration_sec)
start-timer-call ::= "{" ws "\"name\"" ws ":" ws "\"start_timer\"" ws "," ws "\"arguments\"" ws ":" ws start-timer-args ws "}"
start-timer-args ::= "{" ws "\"label\"" ws ":" ws string ws "," ws "\"duration_sec\"" ws ":" ws integer ws "}"
"#;

const CONVERT_UNITS_BLOCK: &str = r#"# convert_units(domain, value, from_unit, to_unit)
convert-units-call ::= "{" ws "\"name\"" ws ":" ws "\"convert_units\"" ws "," ws "\"arguments\"" ws ":" ws convert-units-args ws "}"
convert-units-args ::= "{" ws "\"domain\"" ws ":" ws domain ws "," ws "\"value\"" ws ":" ws number ws "," ws "\"from_unit\"" ws ":" ws unit-id ws "," ws "\"to_unit\"" ws ":" ws unit-id ws "}"
domain ::= "\"mass\"" | "\"volume\"" | "\"temperature\""
"#;

const LIST_MANAGE_BLOCK: &str = r#"# list_manage(op, item?, items?)
list-manage-call ::= "{" ws "\"name\"" ws ":" ws "\"list_manage\"" ws "," ws "\"arguments\"" ws ":" ws list-manage-args ws "}"
list-manage-args ::= "{" ws "\"op\"" ws ":" ws list-op ( ws "," ws "\"item\"" ws ":" ws item-object )? ( ws "," ws "\"items\"" ws ":" ws item-array )? ws "}"
list-op ::= "\"add\"" | "\"remove\"" | "\"check\"" | "\"uncheck\"" | "\"set_all\""
item-array ::= "[" ws ( item-object ( ws "," ws item-object )* )? ws "]"
item-object ::= "{" ws ( item-member ( ws "," ws item-member )* )? ws "}"
item-member ::= "\"id\"" ws ":" ws string | "\"name\"" ws ":" ws string | "\"qty\"" ws ":" ws number | "\"unit\"" ws ":" ws unit-id | "\"checked\"" ws ":" ws boolean
"#;

const CALCULATE_BLOCK: &str = r#"# calculate(op, operands)
calculate-call ::= "{" ws "\"name\"" ws ":" ws "\"calculate\"" ws "," ws "\"arguments\"" ws ":" ws calculate-args ws "}"
calculate-args ::= "{" ws "\"op\"" ws ":" ws calc-op ws "," ws "\"operands\"" ws ":" ws operands ws "}"
calc-op ::= "\"add\"" | "\"sub\"" | "\"mul\"" | "\"div\""
operands ::= "[" ws number ( ws "," ws number )+ ws "]"
"#;

const DATE_MATH_BLOCK: &str = r#"# date_math(base, op, delta)
date-math-call ::= "{" ws "\"name\"" ws ":" ws "\"date_math\"" ws "," ws "\"arguments\"" ws ":" ws date-math-args ws "}"
date-math-args ::= "{" ws "\"base\"" ws ":" ws string ws "," ws "\"op\"" ws ":" ws date-op ws "," ws "\"delta\"" ws ":" ws delta ws "}"
date-op ::= "\"add\"" | "\"sub\""
delta ::= "{" ws ( delta-member ( ws "," ws delta-member )* )? ws "}"
delta-member ::= "\"days\"" ws ":" ws integer | "\"hours\"" ws ":" ws integer | "\"minutes\"" ws ":" ws integer
"#;

const PRIMITIVES: &str = r#"# --- shared JSON primitives ---
unit-id ::= "\"g\"" | "\"kg\"" | "\"oz\"" | "\"lb\"" | "\"ml\"" | "\"l\"" | "\"tsp\"" | "\"tbsp\"" | "\"fl_oz\"" | "\"cup\"" | "\"c\"" | "\"f\""
string ::= "\"" str-char* "\""
str-char ::= [^"\\] | "\\" ["\\/bfnrt]
integer ::= "-"? digit+
number ::= "-"? digit+ ( "." digit+ )? ( [eE] ( "-" | "+" )? digit+ )?
digit ::= [0-9]
boolean ::= "true" | "false"
ws ::= [ \t\n]*

# --- prose branch: assistant free chat text (not a tool call) ---
prose ::= prose-char+
prose-char ::= [^<] | "<" [^t]
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar_is_non_empty_with_two_branch_root() {
        let g = tool_call_grammar();
        assert!(!g.is_empty());
        assert!(g.contains("root ::= tool-call | prose"));
        assert!(g.contains("<tool_call>"));
        assert!(g.contains("prose ::="));
    }

    #[test]
    fn grammar_mentions_every_catalog_tool_name() {
        let g = tool_call_grammar();
        for t in ToolName::ALL {
            assert!(
                g.contains(t.as_ref_str()),
                "grammar is missing the tool name `{}`",
                t.as_ref_str()
            );
        }
    }

    #[test]
    fn every_call_rule_named_in_the_alternation_is_defined() {
        let g = tool_call_grammar();
        for t in ToolName::ALL {
            let rule = tool_call_rule_name(t);
            // the rule is referenced (in `call ::= …`) AND defined (`<rule> ::= …`).
            assert!(g.contains(&rule), "call rule `{rule}` is not referenced");
            assert!(g.contains(&format!("{rule} ::=")), "call rule `{rule}` is not defined");
        }
    }

    #[test]
    fn grammar_is_deterministic_for_a_given_catalog() {
        assert_eq!(tool_call_grammar(), tool_call_grammar());
        assert_eq!(build_grammar(&ToolName::ALL), build_grammar(&ToolName::ALL));
    }

    #[test]
    fn subset_grammar_lists_only_the_selected_tools() {
        let g = build_grammar(&[ToolName::StartTimer]);
        assert!(g.contains("start-timer-call"));
        assert!(g.contains("start_timer"));
        // an unselected tool contributes neither its call rule nor its name literal.
        assert!(!g.contains("date-math-call"));
        assert!(!g.contains("date_math"));
    }
}
