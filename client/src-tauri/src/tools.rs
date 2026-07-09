//! The three fixed, hardcoded Phase-0 tools (P0-03.1): `start_timer`,
//! `convert_units`, `list_manage`. No manifest, no catalog — SPEC's
//! production tool registry (§8.1, §8.5) is deliberately not built here;
//! see PHASE0-PLAN §2.
//!
//! This module also owns the in-memory application state (`AppState`):
//! the running timers and the `ingredients` shared-state slot. This is the
//! Rust side of "Rust core owns … timers" and "tool execution" from
//! `client/IPC-CONTRACT.md`'s responsibility split — the webview never
//! runs a countdown loop or mutates the ingredient list directly, only
//! through `tool_call` / `timer_*` commands (see `main.rs`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::ipc::{
    CmdError, ConvertUnitsArgs, ConvertUnitsResult, IngredientItem, IngredientItemPatch,
    ListManageArgs, ListManageResult, ListOp, StartTimerArgs, StartTimerResult,
    TimerFinishedEvent, TimerStateSnapshot, TimerTickEvent, ToolName, UnitDomain, UnitId,
};

// ---------------------------------------------------------------------------
// Deterministic unit conversion (P0-03.1 AC: "convert_units uses
// deterministic (exact) arithmetic"; underpins the H2 >=98%-exact floor,
// PHASE0-PLAN §4b). MIRRORS client/web/src/app/tools/unit-math.ts — if you
// change a constant here, change it there too. Both sides exist so the
// mock UI (no Rust build available) and the real core agree exactly.
// ---------------------------------------------------------------------------

pub mod unit_math {
    use super::*;

    pub fn mass_to_grams(u: UnitId) -> Option<f64> {
        match u {
            UnitId::G => Some(1.0),
            UnitId::Kg => Some(1000.0),
            UnitId::Oz => Some(28.349_523_125),  // exact: international avoirdupois ounce
            UnitId::Lb => Some(453.592_37),       // exact: international avoirdupois pound
            _ => None,
        }
    }

    pub fn volume_to_ml(u: UnitId) -> Option<f64> {
        match u {
            UnitId::Ml => Some(1.0),
            UnitId::L => Some(1000.0),
            UnitId::Tsp => Some(4.928_921_593_75),      // exact: US legal teaspoon
            UnitId::Tbsp => Some(14.786_764_781_25),    // exact: 3 tsp
            UnitId::FlOz => Some(29.573_529_562_5),     // exact: US fluid ounce
            UnitId::Cup => Some(236.588_236_5),         // exact: US legal cup (8 US fl oz)
            _ => None,
        }
    }

    pub fn domain_of(u: UnitId) -> UnitDomain {
        match u {
            UnitId::G | UnitId::Kg | UnitId::Oz | UnitId::Lb => UnitDomain::Mass,
            UnitId::Ml | UnitId::L | UnitId::Tsp | UnitId::Tbsp | UnitId::FlOz | UnitId::Cup => {
                UnitDomain::Volume
            }
            UnitId::C | UnitId::F => UnitDomain::Temperature,
        }
    }

    pub fn convert(args: &ConvertUnitsArgs) -> Result<ConvertUnitsResult, CmdError> {
        if domain_of(args.from_unit) != args.domain || domain_of(args.to_unit) != args.domain {
            return Err(CmdError::InvalidArgs(format!(
                "{:?}/{:?} do not both belong to domain {:?}",
                args.from_unit, args.to_unit, args.domain
            )));
        }
        let value = match args.domain {
            UnitDomain::Mass => {
                let from = mass_to_grams(args.from_unit).expect("validated above");
                let to = mass_to_grams(args.to_unit).expect("validated above");
                args.value * from / to
            }
            UnitDomain::Volume => {
                let from = volume_to_ml(args.from_unit).expect("validated above");
                let to = volume_to_ml(args.to_unit).expect("validated above");
                args.value * from / to
            }
            UnitDomain::Temperature => match (args.from_unit, args.to_unit) {
                (a, b) if a == b => args.value,
                (UnitId::C, UnitId::F) => args.value * 9.0 / 5.0 + 32.0,
                (UnitId::F, UnitId::C) => (args.value - 32.0) * 5.0 / 9.0,
                _ => return Err(CmdError::InvalidArgs("unsupported temperature units".into())),
            },
        };
        let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
        Ok(ConvertUnitsResult { value: rounded, unit: args.to_unit })
    }
}

// ---------------------------------------------------------------------------
// Argument validation (P0-04.1: "arguments validated against the tool's
// schema before execution"). MIRRORS
// client/web/src/app/tools/tool-validation.ts.
// ---------------------------------------------------------------------------

pub enum TypedToolArgs {
    StartTimer(StartTimerArgs),
    ConvertUnits(ConvertUnitsArgs),
    ListManage(ListManageArgs),
}

pub fn validate_and_parse(
    tool: ToolName,
    raw: &serde_json::Value,
) -> Result<TypedToolArgs, CmdError> {
    match tool {
        ToolName::StartTimer => {
            let args: StartTimerArgs = serde_json::from_value(raw.clone())
                .map_err(|e| CmdError::InvalidArgs(e.to_string()))?;
            if args.label.trim().is_empty() {
                return Err(CmdError::InvalidArgs("label must not be empty".into()));
            }
            if args.duration_sec == 0 {
                return Err(CmdError::InvalidArgs("duration_sec must be positive".into()));
            }
            Ok(TypedToolArgs::StartTimer(args))
        }
        ToolName::ConvertUnits => {
            let args: ConvertUnitsArgs = serde_json::from_value(raw.clone())
                .map_err(|e| CmdError::InvalidArgs(e.to_string()))?;
            if unit_math::domain_of(args.from_unit) != args.domain
                || unit_math::domain_of(args.to_unit) != args.domain
            {
                return Err(CmdError::InvalidArgs(
                    "from_unit/to_unit must both belong to domain".into(),
                ));
            }
            Ok(TypedToolArgs::ConvertUnits(args))
        }
        ToolName::ListManage => {
            let args: ListManageArgs = serde_json::from_value(raw.clone())
                .map_err(|e| CmdError::InvalidArgs(e.to_string()))?;
            match args.op {
                ListOp::Add => {
                    if args.item.as_ref().and_then(|i| i.name.as_ref()).is_none() {
                        return Err(CmdError::InvalidArgs("item.name required for add".into()));
                    }
                }
                ListOp::SetAll => {
                    if args.items.is_none() {
                        return Err(CmdError::InvalidArgs("items required for set_all".into()));
                    }
                }
                ListOp::Remove | ListOp::Check | ListOp::Uncheck => {
                    if args.item.as_ref().and_then(|i| i.id.as_ref()).is_none() {
                        return Err(CmdError::InvalidArgs("item.id required".into()));
                    }
                }
            }
            Ok(TypedToolArgs::ListManage(args))
        }
    }
}

/// Executes an already-validated call, returning `(tool, json result)` —
/// the shape `main.rs`'s `tool_call` command embeds into `ToolCallResponse`.
pub fn execute(
    state: &AppState,
    app: &AppHandle,
    args: TypedToolArgs,
) -> Result<(ToolName, serde_json::Value), CmdError> {
    match args {
        TypedToolArgs::StartTimer(a) => {
            let result = start_timer(state, app, a)?;
            Ok((ToolName::StartTimer, serde_json::to_value(result).unwrap()))
        }
        TypedToolArgs::ConvertUnits(a) => {
            let result = unit_math::convert(&a)?;
            Ok((ToolName::ConvertUnits, serde_json::to_value(result).unwrap()))
        }
        TypedToolArgs::ListManage(a) => {
            let result = list_manage(state, a)?;
            Ok((ToolName::ListManage, serde_json::to_value(result).unwrap()))
        }
    }
}

// ---------------------------------------------------------------------------
// Application state — timers + the `ingredients` shared-state slot
// (SPEC §8.3.4, scoped to Phase 0's single hardcoded slot).
// ---------------------------------------------------------------------------

struct TimerRecord {
    label: String,
    duration_sec: u32,
    remaining_sec: u32,
    running: bool,
    /// False once the background countdown task has exited (only happens
    /// on reaching 0) — tells `reset_timer` whether it needs to respawn.
    task_alive: bool,
}

struct AppStateInner {
    timers: HashMap<String, TimerRecord>,
    ingredients: Vec<IngredientItem>,
    item_seq: u64,
}

/// Cheaply cloneable handle (`Arc<Mutex<..>>`), registered with
/// `.manage()` in `main.rs` and captured by the timer background tasks.
#[derive(Clone)]
pub struct AppState(Arc<Mutex<AppStateInner>>);

impl AppState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(AppStateInner {
            timers: HashMap::new(),
            ingredients: Vec::new(),
            item_seq: 0,
        })))
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// --- start_timer -----------------------------------------------------------

fn start_timer(
    state: &AppState,
    app: &AppHandle,
    args: StartTimerArgs,
) -> Result<StartTimerResult, CmdError> {
    let timer_id = uuid::Uuid::new_v4().to_string();
    let started_at_ms = chrono::Utc::now().timestamp_millis();
    {
        let mut inner = state.0.lock().expect("state mutex poisoned");
        inner.timers.insert(
            timer_id.clone(),
            TimerRecord {
                label: args.label.clone(),
                duration_sec: args.duration_sec,
                remaining_sec: args.duration_sec,
                running: true,
                task_alive: true,
            },
        );
    }
    spawn_timer_task(state.clone(), app.clone(), timer_id.clone());
    Ok(StartTimerResult {
        timer_id,
        label: args.label,
        duration_sec: args.duration_sec,
        started_at_ms,
    })
}

/// One background task per timer, alive from creation until it counts down
/// to 0 (never respawned on pause/resume — only `reset_timer` after a
/// finish needs to spawn a fresh one). Reads shared state every tick so
/// pause/resume/reset commands — which only mutate `AppState` — are picked
/// up on the very next second, no direct task signaling needed.
fn spawn_timer_task(state: AppState, app: AppHandle, timer_id: String) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;

            enum Outcome {
                Idle,
                Ticked { remaining: u32 },
                Finished { label: String },
                Gone,
            }

            let outcome = {
                let mut inner = state.0.lock().expect("state mutex poisoned");
                match inner.timers.get_mut(&timer_id) {
                    None => Outcome::Gone,
                    Some(t) if !t.running => Outcome::Idle,
                    Some(t) if t.remaining_sec == 0 => Outcome::Idle,
                    Some(t) => {
                        t.remaining_sec -= 1;
                        if t.remaining_sec == 0 {
                            t.running = false;
                            t.task_alive = false;
                            Outcome::Finished { label: t.label.clone() }
                        } else {
                            Outcome::Ticked { remaining: t.remaining_sec }
                        }
                    }
                }
            };

            match outcome {
                Outcome::Gone => break,
                Outcome::Idle => continue,
                Outcome::Ticked { remaining } => {
                    let _ = app.emit(
                        "timer://tick",
                        TimerTickEvent { timer_id: timer_id.clone(), remaining_sec: remaining },
                    );
                }
                Outcome::Finished { label } => {
                    let _ = app.emit(
                        "timer://finished",
                        TimerFinishedEvent { timer_id: timer_id.clone(), label },
                    );
                    break;
                }
            }
        }
    });
}

fn snapshot(state: &AppState, timer_id: &str) -> Result<TimerStateSnapshot, CmdError> {
    let inner = state.0.lock().expect("state mutex poisoned");
    let t = inner
        .timers
        .get(timer_id)
        .ok_or_else(|| CmdError::UnknownTimer(timer_id.to_string()))?;
    Ok(TimerStateSnapshot {
        timer_id: timer_id.to_string(),
        label: t.label.clone(),
        duration_sec: t.duration_sec,
        remaining_sec: t.remaining_sec,
        running: t.running,
    })
}

/// Sets `running`. Never respawns a task — pause/resume only ever happen
/// while the original countdown task is still alive (it only exits on
/// finish, at which point `running` is already false and only `reset`
/// can bring the timer back).
pub fn set_timer_running(
    state: &AppState,
    timer_id: &str,
    running: bool,
) -> Result<TimerStateSnapshot, CmdError> {
    {
        let mut inner = state.0.lock().expect("state mutex poisoned");
        let t = inner
            .timers
            .get_mut(timer_id)
            .ok_or_else(|| CmdError::UnknownTimer(timer_id.to_string()))?;
        t.running = running && t.remaining_sec > 0;
    }
    snapshot(state, timer_id)
}

pub fn reset_timer(
    state: &AppState,
    app: &AppHandle,
    timer_id: &str,
) -> Result<TimerStateSnapshot, CmdError> {
    let needs_spawn = {
        let mut inner = state.0.lock().expect("state mutex poisoned");
        let t = inner
            .timers
            .get_mut(timer_id)
            .ok_or_else(|| CmdError::UnknownTimer(timer_id.to_string()))?;
        t.remaining_sec = t.duration_sec;
        t.running = false;
        let needs_spawn = !t.task_alive;
        if needs_spawn {
            t.task_alive = true;
        }
        needs_spawn
    };
    if needs_spawn {
        spawn_timer_task(state.clone(), app.clone(), timer_id.to_string());
    }
    snapshot(state, timer_id)
}

// --- list_manage -----------------------------------------------------------

fn require_id(item: &Option<IngredientItemPatch>) -> Result<String, CmdError> {
    item.as_ref()
        .and_then(|p| p.id.clone())
        .ok_or_else(|| CmdError::InvalidArgs("item.id required".into()))
}

fn list_manage(state: &AppState, args: ListManageArgs) -> Result<ListManageResult, CmdError> {
    let mut inner = state.0.lock().expect("state mutex poisoned");
    match args.op {
        ListOp::Add => {
            let patch = args
                .item
                .ok_or_else(|| CmdError::InvalidArgs("item required for add".into()))?;
            let name = patch
                .name
                .ok_or_else(|| CmdError::InvalidArgs("item.name required for add".into()))?;
            inner.item_seq += 1;
            let id = format!("item_{}", inner.item_seq);
            inner.ingredients.push(IngredientItem {
                id,
                name,
                qty: patch.qty,
                unit: patch.unit,
                checked: Some(false),
            });
        }
        ListOp::Remove => {
            let id = require_id(&args.item)?;
            inner.ingredients.retain(|i| i.id != id);
        }
        ListOp::Check | ListOp::Uncheck => {
            let id = require_id(&args.item)?;
            let checked = matches!(args.op, ListOp::Check);
            if let Some(i) = inner.ingredients.iter_mut().find(|i| i.id == id) {
                i.checked = Some(checked);
            }
        }
        ListOp::SetAll => {
            let items = args
                .items
                .ok_or_else(|| CmdError::InvalidArgs("items required for set_all".into()))?;
            let mut new_list = Vec::with_capacity(items.len());
            for patch in items {
                let id = match patch.id {
                    Some(id) => id,
                    None => {
                        inner.item_seq += 1;
                        format!("item_{}", inner.item_seq)
                    }
                };
                let name = patch.name.ok_or_else(|| {
                    CmdError::InvalidArgs("item.name required in set_all entries".into())
                })?;
                new_list.push(IngredientItem {
                    id,
                    name,
                    qty: patch.qty,
                    unit: patch.unit,
                    checked: Some(patch.checked.unwrap_or(false)),
                });
            }
            inner.ingredients = new_list;
        }
    }
    Ok(ListManageResult { ingredients: inner.ingredients.clone() })
}
