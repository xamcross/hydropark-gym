// Hydropark Phase-0 desktop shell — throwaway validation prototype
// (PHASE0-PLAN.md §0). See client/README.md for what actually builds in
// this environment (no `cargo` here — this crate is authored, not
// compiled) and client/IPC-CONTRACT.md for the full Rust/Angular
// responsibility split this file implements.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capacity;
mod inference;
mod ipc;
mod orchestrator;
mod shared_state;
mod skills;
mod telemetry;
mod tools;
mod unlock;

use tauri::{AppHandle, Manager, State};

use ipc::{
    CmdError, HardwareProfile, InferenceCancelArgs, InferenceStartArgs, NotifyArgs,
    SkillDisableArgs, SkillEnableArgs, SkillEnableResult, TelemetryEvent, TimerControlArgs,
    TimerStateSnapshot, ToolCallError, ToolCallErrorCode, ToolCallRequest, ToolCallResponse,
    ToolName,
};

// ---------------------------------------------------------------------------
// Commands — one per entry in client/web/src/app/ipc/contract.ts's
// `IpcCommandMap`. Every command takes a single `args` parameter (or none)
// because the Angular-side `TauriIpcService` always calls
// `invoke(cmd, { args })` — see that file for why.
// ---------------------------------------------------------------------------

#[tauri::command]
fn tool_call(
    args: ToolCallRequest,
    state: State<'_, tools::AppState>,
    app: AppHandle,
) -> Result<ToolCallResponse, CmdError> {
    let request_id = args.request_id.clone();
    let requested_tool = args.tool;
    match tools::validate_and_parse(args.tool, &args.args) {
        Ok(typed) => match tools::execute(&state, &app, typed) {
            Ok((tool, result)) => Ok(ToolCallResponse::Ok { request_id, ok: true, tool, result }),
            Err(e) => Ok(ToolCallResponse::Err {
                request_id,
                ok: false,
                tool: Some(requested_tool),
                error: ToolCallError { code: ToolCallErrorCode::ExecutionError, message: e.to_string() },
            }),
        },
        Err(e) => Ok(ToolCallResponse::Err {
            request_id,
            ok: false,
            tool: Some(requested_tool),
            error: ToolCallError { code: ToolCallErrorCode::InvalidArgs, message: e.to_string() },
        }),
    }
}

#[tauri::command]
fn inference_start(
    args: InferenceStartArgs,
    state: State<'_, tools::AppState>,
    cancel: State<'_, inference::CancelRegistry>,
    app: AppHandle,
) -> Result<(), CmdError> {
    inference::start(app, state.inner().clone(), cancel.inner().clone(), args);
    Ok(())
}

#[tauri::command]
fn inference_cancel(args: InferenceCancelArgs, cancel: State<'_, inference::CancelRegistry>) -> Result<(), CmdError> {
    cancel.cancel(&args.session_id);
    Ok(())
}

#[tauri::command]
fn skill_enable(args: SkillEnableArgs) -> Result<SkillEnableResult, CmdError> {
    // Phase 0 has no real skill manifest/registry (SPEC §8.5's fixed, audited tool
    // catalog is hardcoded, not loaded). The free `kitchen-timer` skill enables
    // unconditionally; the paid `cooking-assistant` (P0-05.3/.5) is gated on the
    // receipt-unlock. The gate reads a session cache that main()'s setup seeds from
    // unlock.rs's persisted state and that unlock_redeem refreshes - one source of
    // truth (the persisted unlock), one cache the synchronous gate can read.
    if args.skill_id == ipc::SkillId::CookingAssistant
        && skills::cooking_assistant::gate() == skills::cooking_assistant::GateResult::Locked
    {
        return Err(CmdError::SkillLocked);
    }
    Ok(SkillEnableResult {
        skill_id: args.skill_id,
        persona_injected: true,
        tools_registered: vec![ToolName::StartTimer, ToolName::ConvertUnits, ToolName::ListManage],
        panels: vec!["timer_stack".into(), "editable_list".into(), "segmented_toggle".into()],
    })
}

#[tauri::command]
fn skill_disable(_args: SkillDisableArgs) -> Result<(), CmdError> {
    Ok(())
}

/// Runs the deterministic, non-model allergen layer (P0-07.4) over ingredient
/// text and returns the flags. This is what makes the safety layer actually
/// protect the running app rather than only the eval harness: the model is never
/// trusted for this — the layer is rule-based over the Big-9 map in allergens.json.
#[tauri::command]
fn allergen_scan(names: Vec<String>) -> Vec<skills::allergen::AllergenFlag> {
    skills::allergen::scan_ingredients(names)
}

#[tauri::command]
fn timer_pause(args: TimerControlArgs, state: State<'_, tools::AppState>) -> Result<TimerStateSnapshot, CmdError> {
    tools::set_timer_running(&state, &args.timer_id, false)
}

#[tauri::command]
fn timer_resume(args: TimerControlArgs, state: State<'_, tools::AppState>) -> Result<TimerStateSnapshot, CmdError> {
    tools::set_timer_running(&state, &args.timer_id, true)
}

#[tauri::command]
fn timer_reset(
    args: TimerControlArgs,
    state: State<'_, tools::AppState>,
    app: AppHandle,
) -> Result<TimerStateSnapshot, CmdError> {
    tools::reset_timer(&state, &app, &args.timer_id)
}

#[tauri::command]
fn get_hardware_profile() -> Result<HardwareProfile, CmdError> {
    // Read-only (P0-02.3): logged as a covariate, never used to gate a
    // feature. sysinfo's exact unit for `total_memory()` has moved
    // between bytes/KB across major versions — verify against the pinned
    // `sysinfo` version's docs on first real build; the division below
    // assumes bytes (sysinfo >= 0.27).
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_memory();
    sys.refresh_cpu();
    let ram_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    let cores = sys.cpus().len() as u32;
    // sysinfo has no cross-platform GPU API. A real implementation would
    // shell out (e.g. `wmic path win32_VideoController get name` on
    // Windows) or use a platform crate; left `false` here since this
    // field is read-only and never gates anything (P0-02.3 AC).
    let gpu_present = false;
    Ok(HardwareProfile { ram_gb, cores, gpu_present })
}

#[tauri::command]
fn telemetry_log(event: TelemetryEvent, sink: State<'_, telemetry::TelemetrySink>) -> Result<(), CmdError> {
    sink.log(&event)
}

#[tauri::command]
fn notify(args: NotifyArgs, app: AppHandle) -> Result<(), CmdError> {
    // API surface per tauri-plugin-notification v2's `NotificationExt`;
    // re-check exact method names against the pinned plugin version on
    // first real build (P0-05.4: OS notification + sound, degrades to an
    // in-app alert if permission is denied — that in-app fallback itself
    // is rendered by the webview regardless of this call's outcome, see
    // timer-sync.service.ts on the Angular side).
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(&args.title).body(&args.body);
    if args.sound {
        builder = builder.sound("default");
    }
    builder.show().map_err(|e| CmdError::ExecutionError(e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------

/// Hardware profiling (P0-02.3): read RAM + physical cores and which
/// inference backend is compiled in, and log it once at startup. Read-only —
/// this is a covariate for the H2 analysis, never a feature gate. Whether GPU
/// offload was *actually* used is logged separately by the real engine when it
/// loads the model (it depends on the `cuda` feature + n_gpu_layers).
fn log_hardware_profile() {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_memory();
    let ram_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    let physical = sys.physical_core_count().unwrap_or(0);
    let logical = sys.cpus().len();
    let backend = if cfg!(feature = "real-inference") {
        if cfg!(feature = "cuda") {
            "real (llama.cpp, cuda feature compiled)"
        } else {
            "real (llama.cpp, CPU)"
        }
    } else {
        "mock"
    };
    eprintln!(
        "[hydropark] startup hardware profile: {ram_gb:.1} GiB RAM, {physical} physical cores ({logical} logical); inference backend = {backend}"
    );
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(tools::AppState::new())
        .manage(inference::CancelRegistry::new())
        .setup(|app| {
            log_hardware_profile();
            // Seed the paid-skill session cache from the persisted unlock so a
            // returning buyer's Cooking Assistant is already enabled at launch.
            skills::cooking_assistant::set_unlocked(unlock::is_cooking_assistant_unlocked(
                app.handle(),
            ));
            let handle = app.handle();
            let sink = telemetry::TelemetrySink::new(handle)
                .map_err(|e| -> Box<dyn std::error::Error> { Box::new(std::io::Error::other(e.to_string())) })?;
            app.manage(sink);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tool_call,
            inference_start,
            inference_cancel,
            skill_enable,
            skill_disable,
            allergen_scan,
            timer_pause,
            timer_resume,
            timer_reset,
            get_hardware_profile,
            telemetry_log,
            notify,
            unlock::unlock_redeem,
            unlock::unlock_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Hydropark Tauri application");
}
