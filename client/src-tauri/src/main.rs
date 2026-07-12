// Hydropark Phase-0 desktop shell — throwaway validation prototype
// (PHASE0-PLAN.md §0). See client/README.md for what actually builds in
// this environment (no `cargo` here — this crate is authored, not
// compiled) and client/IPC-CONTRACT.md for the full Rust/Angular
// responsibility split this file implements.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend_client;
mod capacity;
mod composition;
mod deep_link;
mod device;
mod grammar;
mod inference;
mod ipc;
mod license_verify;
mod manifest;
mod offline_matrix;
mod orchestrator;
mod package_verify;
mod session;
mod shared_state;
mod skill_manager;
mod skills;
mod store;
mod telemetry;
mod templates;
mod tool_catalog;
mod tool_routing;
mod tools;
mod turn;
mod unlock;

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use backend_client::BackendClient;
use ipc::{
    AuthCredentialsArgs, CatalogDetailArgs, CatalogListArgs, CatalogListResult, CheckoutResult,
    CmdError, DeviceEnsureResult, DownloadUrlArgs, DownloadUrlResult, EntitlementsResult,
    HardwareProfile, InferenceCancelArgs, InferenceStartArgs, LicenseFetchArgs, LicenseResult,
    NotifyArgs, OrderCheckoutArgs, OrderGetArgs, OrderStatusResult, SessionStatus, SkillDetail,
    SkillDisableArgs, SkillEnableArgs, SkillEnableResult, StepUpAnswerArgs, StepUpAnswerResult,
    TelemetryEvent, TimerControlArgs, TimerStateSnapshot, ToolCallError, ToolCallErrorCode,
    ToolCallRequest, ToolCallResponse, ToolName,
};
use session::SessionManager;
use store::Store;

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

/// Compose the enabled skills' manifests into an agent (validate -> merge ->
/// capacity gate -> tool routing). The webview calls this when the enabled-skill
/// set changes; it returns the composed persona/tools/routing/capacity or a
/// structured composition error. Pure (no app state) — see `composition.rs`.
#[tauri::command]
fn compose_agent(
    manifests: Vec<serde_json::Value>,
    primary_hint: Option<String>,
    n_ctx: Option<u32>,
) -> Result<composition::ComposedAgentView, composition::ComposeErrorView> {
    composition::compose_agent_view(&manifests, primary_hint.as_deref(), n_ctx.unwrap_or(4096))
}

// ---------------------------------------------------------------------------
// Marketplace / live-flow commands (P1-08.x). The Rust core owns network egress
// (the webview CSP is `connect-src 'self'`), so catalog / orders / entitlements
// / license / download all cross the IPC boundary here and delegate to
// `backend_client.rs`. Each clones the managed `BackendClient` out of `State`
// before awaiting so no `State` borrow is held across an `.await`. `catalog_*`
// are PUBLIC (no bearer); the rest pass an optional bearer access token through
// when present (the client auth flow that mints it is a later tranche).
// ---------------------------------------------------------------------------

#[tauri::command]
async fn catalog_list(
    args: CatalogListArgs,
    client: State<'_, BackendClient>,
) -> Result<CatalogListResult, CmdError> {
    let client = client.inner().clone();
    let skills = client.catalog_list(args.region.as_deref()).await?;
    Ok(CatalogListResult { skills })
}

#[tauri::command]
async fn catalog_detail(
    args: CatalogDetailArgs,
    client: State<'_, BackendClient>,
) -> Result<SkillDetail, CmdError> {
    let client = client.inner().clone();
    Ok(client.catalog_detail(&args.skill_id).await?)
}

// The authed commerce commands (orders / entitlements / license / download) now
// attach the STORED bearer automatically via the `SessionManager` — the caller's
// `args.bearer` from T3 is optional and ignored (the session is the source of
// truth). `bearer()` transparently refreshes a near-expiry access token first.

#[tauri::command]
async fn order_checkout(
    args: OrderCheckoutArgs,
    session: State<'_, SessionManager>,
) -> Result<CheckoutResult, CmdError> {
    let session = session.inner().clone();
    let bearer = session.bearer().await;
    Ok(session
        .client()
        .order_checkout(&args.target_id, &args.region, bearer.as_deref())
        .await?)
}

#[tauri::command]
async fn order_get(
    args: OrderGetArgs,
    session: State<'_, SessionManager>,
) -> Result<OrderStatusResult, CmdError> {
    let session = session.inner().clone();
    let bearer = session.bearer().await;
    Ok(session.client().order_get(&args.order_id, bearer.as_deref()).await?)
}

// `entitlements_get` no longer needs the T3 `bearer` arg (the session supplies it),
// so it takes no data parameter — any `{ args: {} }` the webview still sends is
// ignored by Tauri's per-argument binding.
#[tauri::command]
async fn entitlements_get(
    session: State<'_, SessionManager>,
) -> Result<EntitlementsResult, CmdError> {
    let session = session.inner().clone();
    let bearer = session.bearer().await;
    let skills = session.client().entitlements_get(bearer.as_deref()).await?;
    Ok(EntitlementsResult { skills })
}

#[tauri::command]
async fn license_fetch(
    args: LicenseFetchArgs,
    session: State<'_, SessionManager>,
) -> Result<LicenseResult, CmdError> {
    let session = session.inner().clone();
    let bearer = session.bearer().await;
    // Bind the license to this install's stable device id (issuance-time binding;
    // never re-derived offline to verify — see license_verify.rs / §13.12).
    let device_id = device::ensure_identity(session.store())?.install_id;
    Ok(session
        .client()
        .license_fetch(&args.skill_id, bearer.as_deref(), Some(&device_id))
        .await?)
}

#[tauri::command]
async fn download_url(
    args: DownloadUrlArgs,
    session: State<'_, SessionManager>,
) -> Result<DownloadUrlResult, CmdError> {
    let session = session.inner().clone();
    let bearer = session.bearer().await;
    Ok(session
        .client()
        .download_url(&args.skill_id, &args.version, bearer.as_deref())
        .await?)
}

// ---------------------------------------------------------------------------
// Accounts / licensing (P1-09) + step-up (P1-09.8). The Rust core owns the
// session: register/login/refresh/logout hit `/v1/auth` and persist the token
// pair in the T2 SQLite store; `auth_status` reports it. `device_ensure` mints
// the stable install id + keypair and registers with `/v1/devices`;
// `entitlements_refresh` caches `/v1/entitlements` locally; `step_up_answer`
// signs a server challenge with the persisted device key.
// ---------------------------------------------------------------------------

/// Assemble the account+device status the webview hydrates from. Always resolves
/// the stable install id (minting the local identity on first call), so `deviceId`
/// is present even when signed out.
fn session_status(session: &SessionManager) -> Result<SessionStatus, CmdError> {
    let identity = device::ensure_identity(session.store())?;
    let current = session.current();
    Ok(SessionStatus {
        authenticated: current.is_some(),
        email: current.and_then(|s| s.email),
        device_id: identity.install_id,
    })
}

#[tauri::command]
async fn auth_register(
    args: AuthCredentialsArgs,
    session: State<'_, SessionManager>,
) -> Result<SessionStatus, CmdError> {
    let session = session.inner().clone();
    session.register(&args.email, &args.password).await?;
    session_status(&session)
}

#[tauri::command]
async fn auth_login(
    args: AuthCredentialsArgs,
    session: State<'_, SessionManager>,
) -> Result<SessionStatus, CmdError> {
    let session = session.inner().clone();
    session.login(&args.email, &args.password).await?;
    session_status(&session)
}

#[tauri::command]
async fn auth_logout(session: State<'_, SessionManager>) -> Result<SessionStatus, CmdError> {
    let session = session.inner().clone();
    session.logout().await?;
    session_status(&session)
}

#[tauri::command]
fn auth_status(session: State<'_, SessionManager>) -> Result<SessionStatus, CmdError> {
    session_status(session.inner())
}

#[tauri::command]
async fn device_ensure(
    session: State<'_, SessionManager>,
) -> Result<DeviceEnsureResult, CmdError> {
    let session = session.inner().clone();
    // Always ensure a local identity exists (install id + keypair + fingerprint).
    let identity = device::ensure_identity(session.store())?;
    let mut registered = identity.registered;

    // Register with the backend device registry when we have a session (it needs a
    // bearer; the FIRST device is trusted-on-first-use, so no step-up token). A
    // network failure is non-fatal — the local identity is what the app needs; the
    // webview can retry.
    if !registered {
        if let Some(bearer) = session.bearer().await {
            let name = device::default_device_name();
            let fingerprint = device::fingerprint(&identity);
            match session
                .client()
                .device_register(&name, &fingerprint, Some(&bearer), None)
                .await
            {
                Ok(dev) => {
                    device::mark_registered(session.store(), &dev.device_id)?;
                    registered = true;
                }
                Err(_) => { /* leave registered = false; caller may retry */ }
            }
        }
    }

    Ok(DeviceEnsureResult { device_id: identity.install_id, registered })
}

#[tauri::command]
async fn entitlements_refresh(
    session: State<'_, SessionManager>,
) -> Result<EntitlementsResult, CmdError> {
    let session = session.inner().clone();
    let skills = session.refresh_entitlements().await?;
    Ok(EntitlementsResult { skills })
}

#[tauri::command]
fn step_up_answer(
    args: StepUpAnswerArgs,
    session: State<'_, SessionManager>,
) -> Result<StepUpAnswerResult, CmdError> {
    let signed = device::sign_challenge(session.inner().store(), &args.challenge)?;
    Ok(StepUpAnswerResult { signature: signed.signature, device_id: signed.device_id })
}

/// Open (creating + migrating) the on-device SQLite store under the app-data dir.
fn open_app_store(app: &AppHandle) -> Result<Store, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(Store::open(dir.join("hydropark.db"))?)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // P1-01.2: register the `hydropark://` scheme (see tauri.conf.json /
        // capabilities). The purchase-callback handler is wired in `setup` below.
        .plugin(tauri_plugin_deep_link::init())
        .manage(tools::AppState::new())
        .manage(inference::CancelRegistry::new())
        .manage(BackendClient::new())
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

            // On-device SQLite store (P1-10) — resolved from the app-data dir — and
            // the account session manager built over it, sharing the managed backend
            // client (same reqwest connection pool).
            let store = open_app_store(app.handle())
                .map_err(|e| -> Box<dyn std::error::Error> { Box::new(std::io::Error::other(e.to_string())) })?;
            let store = Arc::new(Mutex::new(store));
            let backend = app.state::<BackendClient>().inner().clone();
            let session = SessionManager::new(store, backend);
            app.manage(session.clone());

            // P1-01.2 deep-link: on a `hydropark://` purchase-callback, emit the
            // webview event `purchase://callback` { orderId } the purchase flow
            // listens for. Non-callback links are ignored.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Dev convenience: claim the scheme at runtime (the NSIS installer
                // registers it for production). Best-effort; a failure is harmless.
                #[cfg(debug_assertions)]
                let _ = app.deep_link().register(deep_link::SCHEME);

                let emit_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(order_id) = deep_link::parse_purchase_callback(url.as_str()) {
                            let _ = emit_handle
                                .emit("purchase://callback", serde_json::json!({ "orderId": order_id }));
                        }
                    }
                });
            }

            // P1-09.7: refresh entitlements once at startup if a session exists,
            // off the main thread so launch is never blocked on the network.
            if session.current().is_some() {
                let bg = session.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = bg.refresh_entitlements().await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tool_call,
            compose_agent,
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
            catalog_list,
            catalog_detail,
            order_checkout,
            order_get,
            entitlements_get,
            license_fetch,
            download_url,
            auth_register,
            auth_login,
            auth_logout,
            auth_status,
            device_ensure,
            entitlements_refresh,
            step_up_answer,
            unlock::unlock_redeem,
            unlock::unlock_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Hydropark Tauri application");
}
