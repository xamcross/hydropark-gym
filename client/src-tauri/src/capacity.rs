#![allow(dead_code)] // Phase-1 composition core; wired into the compose/turn loop in a later ticket.

//! Capacity meter & speed headroom (P1-04.7/.8, SPEC §8.3.5, §18, §7.3).
//!
//! Before a set of *enabled* skills is composed (see `orchestrator::merge`),
//! the app must answer two independent questions about **compute** cost — never
//! money (§8.3.5):
//!
//!  - **Context capacity** (P1-04.7, §8.3.5): does the projected prompt still
//!    leave room for the running conversation inside the model's context
//!    window? The projection is a fixed **working reserve** (held back for the
//!    live transcript + this turn's generation) **+** Σ each enabled skill's
//!    certified `cost_estimate`. If the total **exceeds** the window the combo
//!    is **blocked** — the one hard gate here — with the exact overflow so the
//!    caller can render the meter and suggest a skill to drop. See [`project`].
//!  - **Speed headroom** (P1-04.8, §8.3.5, §18): at the measured/estimated
//!    tokens-per-second, will turns feel sluggish? This **only ever warns**
//!    (amber meter) and always allows — the Recommended tier's floor is ≥ 8
//!    tok/s (§18). The result type [`HeadroomStatus`] has no `Blocked` variant
//!    *by construction*, so "speed never blocks" is enforced by the type, not a
//!    convention. See [`assess_headroom`].
//!
//! Both entry points are **re-evaluable as the conversation grows**: pass the
//! live transcript's token count to [`project_live`] (and feed the resulting
//! projection back into [`assess_headroom`]). This module never *decides* to
//! enable/disable anything and never auto-disables mid-session (§8.3.5) — it
//! only reports the numbers; the caller (and the user) stay in control.
//!
//! Like `orchestrator`, this module is intentionally free of any Tauri /
//! inference coupling so it is pure and unit-testable
//! (`cargo test --no-default-features --features mock-inference`).

use crate::orchestrator::SkillManifest;

// ---------------------------------------------------------------------------
// Constants (documented; the numbers a reviewer will want to sanity-check).
// ---------------------------------------------------------------------------

/// Default model context window, in tokens. Mirrors the real engine's
/// `HYDROPARK_N_CTX` default (`inference.rs`, `mod real`) and is duplicated here
/// as a plain `const` so the meter stays free of any inference coupling. The
/// window is **overridable** — callers pass the actual `n_ctx` into [`project`].
pub const DEFAULT_N_CTX: u32 = 4096;

/// Denominator of the **working-reserve fraction**: the reserve is `n_ctx /
/// RESERVE_FRACTION_DENOM`. At the default 4096 window this is a 1024-token
/// reserve (¼ of the window) held back for the live conversation + this turn's
/// generation, so enabling skills can never crowd the running chat out of the
/// window (§8.3.5, "a fixed working-conversation reserve … so live chat history
/// always has room"). A fraction (not a flat constant) keeps the reserve sane
/// if the window is overridden up or down.
pub const RESERVE_FRACTION_DENOM: u32 = 4;

/// Absolute floor for the working reserve, in tokens. Even a small overridden
/// window must hold back room for at least one full model reply, so the reserve
/// never drops below the real engine's default generation budget
/// (`HYDROPARK_MAX_TOKENS` = 512 in `inference.rs`). At the default 4096 window
/// the fraction (1024) dominates and this floor is invisible; it only bites for
/// unusually small windows.
pub const MIN_RESERVE_TOKENS: u32 = 512;

/// Small per-declared-tool token top-up added on top of a skill's
/// `cost_estimate.prompt_tokens`. NOTE: `prompt_tokens` already includes tool
/// *schemas* (per the manifest schema), so this is deliberately tiny — it only
/// covers merge-time costs the per-skill self-estimate cannot see (tool-union
/// bookkeeping / namespacing when several skills share a `ref`, §8.3.3). Erring
/// slightly *conservative* is the safe direction for a block-on-overflow gate.
pub const PER_TOOL_TOKENS: u32 = 8;

/// Small per-declared-panel token top-up. Panels are UI widgets (§9) and are
/// *not* counted in `cost_estimate.prompt_tokens`; each still adds a little to
/// the prompt via its shared-state binding descriptor / few-shot exemplar, so
/// the meter charges a modest amount per panel. Conservative on purpose.
pub const PER_PANEL_TOKENS: u32 = 16;

/// The Recommended-tier throughput floor, in tokens/sec (§18: "first token
/// < ~2 s and ≥ ~8 tok/s on the Recommended tier"; §7.3 tiers). At or above
/// this, headroom is comfortable; below it the app **warns** (never blocks).
pub const RECOMMENDED_TOK_PER_SEC_FLOOR: f64 = 8.0;

/// Context-fill ratio at/above which per-turn latency is projected to turn
/// **sluggish** even when raw throughput clears the floor: a nearly-full window
/// means a long prefill every turn and imminent history-condensing (§8.3.5,
/// "re-evaluates as the conversation grows … condenses old history and warns").
/// 0.85 ⇒ the window is ~85 %+ full. A warn trigger, never a block.
pub const LOAD_WARN_FILL_RATIO: f64 = 0.85;

// ---------------------------------------------------------------------------
// Context capacity (P1-04.7, §8.3.5).
// ---------------------------------------------------------------------------

/// The numbers the caller needs to both **gate** the combination and **render**
/// the capacity meter. All figures are tokens.
///
/// Invariant: `used_tokens == reserve_tokens + <live transcript> + skill_tokens`
/// and exactly one of `remaining` / the `Blocked` overflow is non-zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityProjection {
    /// The model context window this projection was computed against.
    pub ctx_window: u32,
    /// Tokens held back for the running conversation + generation (the working
    /// reserve). Always subtracted first.
    pub reserve_tokens: u32,
    /// Σ over the enabled skills of their certified cost (prompt + small
    /// per-tool / per-panel top-up).
    pub skill_tokens: u32,
    /// Total projected occupancy = reserve + live transcript + skill tokens.
    pub used_tokens: u32,
    /// Free tokens left in the window (`ctx_window - used_tokens`); `0` when
    /// blocked.
    pub remaining: u32,
    /// Whether the combination fits or is blocked on overflow.
    pub status: CapacityStatus,
}

/// The capacity verdict. Capacity is the **one hard gate**: it blocks
/// (§8.3.5 "context-capacity overflow blocks before enabling").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapacityStatus {
    /// The projection fits within the context window (green/amber meter — the
    /// caller decides colour from `remaining`). Enabling is allowed.
    Ok,
    /// The projection **exceeds** the window by `overflow` tokens; enabling is
    /// blocked. The caller surfaces the number and suggests a skill to drop.
    Blocked { overflow: u32 },
}

/// The projected token cost of a single skill: its certified `prompt_tokens`
/// (which already bundles the skill's prompt + tool schemas + few-shot) plus a
/// small, documented per-tool / per-panel composition top-up. Saturating
/// throughout so adversarial figures can never wrap.
fn skill_cost(skill: &SkillManifest) -> u32 {
    let c = &skill.cost_estimate;
    c.prompt_tokens
        .saturating_add(c.tools.saturating_mul(PER_TOOL_TOKENS))
        .saturating_add(c.panels.saturating_mul(PER_PANEL_TOKENS))
}

/// The working reserve for a given window: a fraction of `n_ctx`, but never
/// below [`MIN_RESERVE_TOKENS`].
fn reserve_for(n_ctx: u32) -> u32 {
    (n_ctx / RESERVE_FRACTION_DENOM).max(MIN_RESERVE_TOKENS)
}

/// Project context capacity for `enabled` against `n_ctx`, **before** any chat
/// has accumulated (the pre-enable gate). Equivalent to [`project_live`] with a
/// zero-length live transcript.
pub fn project(enabled: &[SkillManifest], n_ctx: u32) -> CapacityProjection {
    project_live(enabled, n_ctx, 0)
}

/// Re-evaluable projection as the live conversation grows: `used = reserve +
/// live_transcript_tokens + skill_tokens`. Call this again each turn with the
/// updated transcript token count to drive the live meter. Blocks when
/// `used_tokens` **exceeds** `n_ctx` (exact fit is *not* an overflow).
///
/// All arithmetic saturates, so pathological inputs report a pinned overflow
/// rather than wrapping.
pub fn project_live(
    enabled: &[SkillManifest],
    n_ctx: u32,
    live_transcript_tokens: u32,
) -> CapacityProjection {
    let reserve_tokens = reserve_for(n_ctx);
    let skill_tokens =
        enabled.iter().fold(0u32, |acc, s| acc.saturating_add(skill_cost(s)));
    let used_tokens = reserve_tokens
        .saturating_add(live_transcript_tokens)
        .saturating_add(skill_tokens);

    let (status, remaining) = if used_tokens > n_ctx {
        (CapacityStatus::Blocked { overflow: used_tokens - n_ctx }, 0)
    } else {
        (CapacityStatus::Ok, n_ctx - used_tokens)
    };

    CapacityProjection {
        ctx_window: n_ctx,
        reserve_tokens,
        skill_tokens,
        used_tokens,
        remaining,
        status,
    }
}

// ---------------------------------------------------------------------------
// Speed headroom (P1-04.8, §8.3.5, §18).
// ---------------------------------------------------------------------------

/// The speed verdict. Unlike [`CapacityStatus`] there is **no `Blocked`
/// variant** — speed headroom only ever warns and always allows (§8.3.5:
/// a speed-headroom shortfall *warns*, it does not block). Making "never
/// blocks" a property of the type is deliberate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadroomStatus {
    /// Throughput is comfortable for the composed load (green meter).
    Ok,
    /// Turns are projected to feel slow, but the combination is still allowed
    /// (amber meter). `reason` is a ready-to-show explanation.
    Warn { reason: String },
}

/// Assess speed headroom for a measured/estimated throughput against a capacity
/// projection (the composed load). Warns — never blocks — when either:
///
///  1. `measured_tok_per_sec` is **below** [`RECOMMENDED_TOK_PER_SEC_FLOOR`]
///     (§18's ≥ 8 tok/s Recommended floor); or
///  2. the context is at/above [`LOAD_WARN_FILL_RATIO`] full, so per-turn
///     latency is projected to grow sluggish as history accumulates — even when
///     raw throughput clears the floor.
///
/// Re-evaluable: pass a fresh projection (from [`project_live`]) and/or a fresh
/// throughput measurement as the chat grows. The `>= floor` case is `Ok` (an
/// exact 8.0 tok/s is comfortable, matching §18's "≥ ~8 tok/s").
pub fn assess_headroom(
    measured_tok_per_sec: f64,
    projection: &CapacityProjection,
) -> HeadroomStatus {
    if measured_tok_per_sec < RECOMMENDED_TOK_PER_SEC_FLOOR {
        return HeadroomStatus::Warn {
            reason: format!(
                "throughput {measured_tok_per_sec:.1} tok/s is below the Recommended-tier \
                 floor of {RECOMMENDED_TOK_PER_SEC_FLOOR:.0} tok/s — responses will feel slow"
            ),
        };
    }

    let fill = if projection.ctx_window > 0 {
        f64::from(projection.used_tokens) / f64::from(projection.ctx_window)
    } else {
        1.0
    };
    if fill >= LOAD_WARN_FILL_RATIO {
        return HeadroomStatus::Warn {
            reason: format!(
                "context is {:.0}% full ({}/{} tokens) — turns will slow as history grows; \
                 consider condensing old messages or dropping a skill",
                fill * 100.0,
                projection.used_tokens,
                projection.ctx_window
            ),
        };
    }

    HeadroomStatus::Ok
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build a `SkillManifest` from a JSON literal, exactly like the
    /// orchestrator tests do (fields the meter ignores may be omitted).
    fn m(v: serde_json::Value) -> SkillManifest {
        serde_json::from_value(v).expect("valid test manifest")
    }

    /// A skill whose only cost is `prompt_tokens` (no tool/panel top-up).
    fn skill(id: &str, prompt_tokens: u32) -> SkillManifest {
        m(json!({"id": id, "cost_estimate": {"prompt_tokens": prompt_tokens}}))
    }

    // ---- reserve --------------------------------------------------------

    #[test]
    fn default_reserve_is_a_quarter_of_the_window() {
        // 4096 / 4 = 1024, well above the 512 floor.
        assert_eq!(reserve_for(DEFAULT_N_CTX), 1024);
    }

    #[test]
    fn reserve_never_drops_below_the_floor() {
        // 1000 / 4 = 250, clamped up to the 512-token floor.
        assert_eq!(reserve_for(1000), MIN_RESERVE_TOKENS);
    }

    #[test]
    fn reserve_is_subtracted_even_with_no_skills() {
        let p = project(&[], DEFAULT_N_CTX);
        assert_eq!(p.skill_tokens, 0);
        // used is purely the reserve; the rest of the window is free.
        assert_eq!(p.used_tokens, p.reserve_tokens);
        assert_eq!(p.reserve_tokens, 1024);
        assert_eq!(p.remaining, DEFAULT_N_CTX - 1024);
        assert_eq!(p.status, CapacityStatus::Ok);
    }

    // ---- skill cost -----------------------------------------------------

    #[test]
    fn skill_cost_adds_per_tool_and_per_panel_topups() {
        // 100 prompt + 2 tools * 8 + 1 panel * 16 = 100 + 16 + 16 = 132.
        let s = m(json!({
            "id": "a",
            "cost_estimate": {"prompt_tokens": 100, "tools": 2, "panels": 1}
        }));
        assert_eq!(skill_cost(&s), 132);
        let p = project(&[s], DEFAULT_N_CTX);
        assert_eq!(p.skill_tokens, 132);
    }

    #[test]
    fn skill_tokens_sum_across_enabled_skills() {
        let p = project(&[skill("a", 300), skill("b", 200), skill("c", 100)], DEFAULT_N_CTX);
        assert_eq!(p.skill_tokens, 600);
    }

    // ---- under budget ---------------------------------------------------

    #[test]
    fn under_budget_is_ok_with_correct_remaining() {
        // reserve 1024 + skills 1000 = 2024 used; 4096 - 2024 = 2072 free.
        let p = project(&[skill("a", 1000)], DEFAULT_N_CTX);
        assert_eq!(p.used_tokens, 2024);
        assert_eq!(p.remaining, 2072);
        assert_eq!(p.status, CapacityStatus::Ok);
    }

    // ---- over budget ----------------------------------------------------

    #[test]
    fn over_budget_is_blocked_with_exact_overflow() {
        // reserve 1024 + 3200 = 4224 used; over 4096 by exactly 128.
        let p = project(&[skill("big", 3200)], DEFAULT_N_CTX);
        assert_eq!(p.used_tokens, 4224);
        assert_eq!(p.status, CapacityStatus::Blocked { overflow: 128 });
        // remaining is pinned to 0 while blocked.
        assert_eq!(p.remaining, 0);
    }

    // ---- boundaries -----------------------------------------------------

    #[test]
    fn exact_fit_is_ok_not_blocked() {
        // reserve 1024 + 3072 = 4096 == window exactly. "Exceeds" is strict, so
        // this fits: Ok, with zero headroom left.
        let p = project(&[skill("fit", 3072)], DEFAULT_N_CTX);
        assert_eq!(p.used_tokens, DEFAULT_N_CTX);
        assert_eq!(p.status, CapacityStatus::Ok);
        assert_eq!(p.remaining, 0);
    }

    #[test]
    fn one_token_over_the_window_blocks_with_overflow_one() {
        let p = project(&[skill("fit", 3073)], DEFAULT_N_CTX);
        assert_eq!(p.status, CapacityStatus::Blocked { overflow: 1 });
        assert_eq!(p.remaining, 0);
    }

    // ---- growth pushes a borderline case over --------------------------

    #[test]
    fn conversation_growth_pushes_a_borderline_combo_over() {
        let enabled = [skill("a", 2000)]; // static: 1024 + 2000 = 3024, fits.
        let base = project_live(&enabled, DEFAULT_N_CTX, 0);
        assert_eq!(base.status, CapacityStatus::Ok);
        assert_eq!(base.remaining, 1072); // 4096 - 3024

        // Grow the transcript to exactly fill the window: still Ok, 0 left.
        let full = project_live(&enabled, DEFAULT_N_CTX, 1072);
        assert_eq!(full.used_tokens, DEFAULT_N_CTX);
        assert_eq!(full.status, CapacityStatus::Ok);

        // One more token of chat tips it over: blocked by exactly 1.
        let over = project_live(&enabled, DEFAULT_N_CTX, 1073);
        assert_eq!(over.status, CapacityStatus::Blocked { overflow: 1 });
    }

    // ---- overridable window --------------------------------------------

    #[test]
    fn honours_an_overridden_context_window() {
        // Larger window (e.g. HYDROPARK_N_CTX=8192): reserve 2048, lots of room.
        let p = project(&[skill("a", 1000)], 8192);
        assert_eq!(p.ctx_window, 8192);
        assert_eq!(p.reserve_tokens, 2048);
        assert_eq!(p.used_tokens, 3048);
        assert_eq!(p.status, CapacityStatus::Ok);
    }

    // ---- speed headroom -------------------------------------------------

    /// A comfortable, low-fill projection to isolate the speed axis.
    fn light_projection() -> CapacityProjection {
        project(&[skill("a", 500)], DEFAULT_N_CTX) // used 1524 / 4096 ≈ 37% full
    }

    #[test]
    fn speed_at_or_above_floor_is_ok() {
        // Comfortably above.
        assert_eq!(assess_headroom(12.0, &light_projection()), HeadroomStatus::Ok);
        // Exactly the floor (>= 8 ⇒ Ok, per §18 "≥ ~8 tok/s").
        assert_eq!(
            assess_headroom(RECOMMENDED_TOK_PER_SEC_FLOOR, &light_projection()),
            HeadroomStatus::Ok
        );
    }

    #[test]
    fn speed_below_floor_warns_and_never_blocks() {
        for tps in [7.9, 5.0, 1.0, 0.0] {
            let status = assess_headroom(tps, &light_projection());
            assert!(
                matches!(status, HeadroomStatus::Warn { .. }),
                "expected Warn at {tps} tok/s, got {status:?}"
            );
        }
        // The type has no Blocked variant; a slow speed can only ever be
        // Ok or Warn, and here it must be Warn (asserted above) — so speed
        // headroom can never block. (Exhaustiveness enforced by the compiler.)
    }

    #[test]
    fn high_context_fill_warns_even_when_speed_clears_the_floor() {
        // reserve 1024 + 2600 = 3624 used; 3624 / 4096 ≈ 88.5% >= 85%.
        let heavy = project(&[skill("heavy", 2600)], DEFAULT_N_CTX);
        assert_eq!(heavy.status, CapacityStatus::Ok); // capacity still fits...
        // ...but a nearly-full window warns on speed, despite fast throughput.
        let status = assess_headroom(30.0, &heavy);
        assert!(matches!(status, HeadroomStatus::Warn { .. }), "got {status:?}");
    }

    #[test]
    fn comfortable_speed_and_light_load_is_ok() {
        assert_eq!(assess_headroom(20.0, &light_projection()), HeadroomStatus::Ok);
    }

    #[test]
    fn headroom_is_re_evaluable_as_chat_grows() {
        let enabled = [skill("a", 1500)];
        // Early: 1024 + 1500 = 2524 / 4096 ≈ 62% full, fast enough ⇒ Ok.
        let early = project_live(&enabled, DEFAULT_N_CTX, 0);
        assert_eq!(assess_headroom(15.0, &early), HeadroomStatus::Ok);
        // Later: transcript grew by 1000 ⇒ 3524 / 4096 ≈ 86% ⇒ Warn, still fast.
        let later = project_live(&enabled, DEFAULT_N_CTX, 1000);
        assert!(matches!(assess_headroom(15.0, &later), HeadroomStatus::Warn { .. }));
    }
}
