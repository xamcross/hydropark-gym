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
mod downloader;
mod fetch_guard;
mod grammar;
mod hpskill;
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
mod updater;

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use backend_client::BackendClient;
use hpskill::SkillInstaller;
use ipc::{
    AuthCredentialsArgs, CapabilityDiscloseArgs, CatalogDetailArgs, CatalogListArgs, CatalogListResult, CheckoutResult,
    CmdError, ComposeAgentArgs, DownloadUrlArgs, DownloadUrlResult, EntitlementsResult,
    HardwareProfile, InferenceCancelArgs, InferenceStartArgs, LicenseFetchArgs, LicenseResult,
    NotifyArgs, OrderCheckoutArgs, OrderGetArgs, OrderStatusResult, SessionStatus, SkillDetail,
    SkillDisableArgs, SkillDownloadInstallArgs, SkillEnableArgs, SkillEnableResult, SkillInstallArgs,
    SkillInstallResult, SkillUninstallArgs, SkillUninstallResult, StepUpAnswerArgs, StepUpAnswerResult,
    TelemetryEvent, TemplateLoadArgs, TemplateLoadResult, TemplateSaveArgs, TemplateView,
    TimerControlArgs, TimerStateSnapshot, ToolCallError, ToolCallErrorCode, ToolCallRequest,
    ToolCallResponse, ToolName, UiStateLoadArgs, UiStateSaveArgs, UpdateCheckResult,
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

/// Install a downloaded `.hpskill` package (P1-03.2): the Rust core verifies its
/// detached signature against the pinned trust set, re-validates the manifest, gates on
/// host compatibility, extracts the sanitized assets to the app-data skills dir, and
/// registers + persists the install. Fail-closed — a rejected package writes nothing.
#[tauri::command]
fn skill_install(
    args: SkillInstallArgs,
    installer: State<'_, SkillInstaller>,
) -> Result<SkillInstallResult, CmdError> {
    let outcome = installer
        .install_from_path(std::path::Path::new(&args.path))
        .map_err(|e| CmdError::Package(e.to_string()))?;
    Ok(SkillInstallResult {
        skill_id: outcome.id,
        version: outcome.version,
        dir: outcome.dir.to_string_lossy().into_owned(),
        state: hpskill::state_label(outcome.state).to_string(),
    })
}

/// Uninstall a skill package (P1-03.2): frees the disk + the persisted registry row,
/// keeps ownership (a reinstall is free, §11.3).
#[tauri::command]
fn skill_uninstall(
    args: SkillUninstallArgs,
    installer: State<'_, SkillInstaller>,
) -> Result<SkillUninstallResult, CmdError> {
    let state = installer
        .uninstall(&args.skill_id)
        .map_err(|e| CmdError::Package(e.to_string()))?;
    Ok(SkillUninstallResult { skill_id: args.skill_id, state: hpskill::state_label(state).to_string() })
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
    args: ComposeAgentArgs,
) -> Result<composition::ComposedAgentView, composition::ComposeErrorView> {
    composition::compose_agent_view(
        &args.manifests,
        args.primary_hint.as_deref(),
        args.n_ctx.unwrap_or(4096),
    )
}

/// P1-11.2 app auto-update seam. Asks `tauri-plugin-updater` whether a newer *signed*
/// build is published at the configured endpoint and returns the typed status the
/// webview's update surface renders ("Up to date" / "Update available" / "Updating…").
///
/// OFFLINE-SAFE (§18): `updater::check` swallows every failure — offline, an
/// unreachable endpoint, or the PLACEHOLDER endpoint/pubkey that ships until the
/// update server + signing key are provisioned (the release GATE) — into a benign,
/// typed status, so this command NEVER rejects and an update check can never block
/// offline use.
#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<UpdateCheckResult, CmdError> {
    Ok(updater::check(&app).await)
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
    // Bind the license to the SERVER-side device id (the slot id
    // `POST /v1/devices/register` returned and `mark_registered` persisted), NOT the
    // local install id: the backend's LICENSE_ISSUE path calls
    // `DeviceSlotPort.assertActiveSlot(userId, deviceId)` and returns 404
    // ("device not found") for any id it never registered — the local install id is
    // never sent to the server. Offline verification never re-derives device_id
    // (license_verify.rs / §13.12), so this is purely the issuance-binding id.
    let identity = device::ensure_identity(session.store())?;
    let device_id = identity.server_device_id.ok_or_else(|| {
        CmdError::Backend("device is not registered with the server yet".to_string())
    })?;
    // P0 fix: `LicenseController` unconditionally requires a valid step-up
    // proof (`assertStepUp`) before issuing — TOFU only covers the FIRST device
    // this account ever binds, and `device_ensure` already spends it via
    // `/v1/devices/register` before any purchase happens, so by the time this
    // command runs step-up is always required. For a device-only account the
    // proof factor IS the one-time recovery code captured at register time
    // (`session::ensure_device_session`) and persisted alongside the device
    // identity — read it back here and always send it when present (harmless
    // if TOFU somehow still applied; the backend simply ignores an unneeded
    // proof — but required otherwise, which is the normal case).
    let step_up_token = device::recovery_code(session.store())?;
    Ok(session
        .client()
        .license_fetch(&args.skill_id, bearer.as_deref(), Some(&device_id), step_up_token.as_deref())
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

/// Fetch the signed `.hpskill` blob at `args.url` (the URL `download_url` just
/// returned) and install it — the purchase flow's bridge from P1-08.x commerce
/// into the P1-03.2 install pipeline. The Rust core owns the fetch (the webview
/// CSP is `connect-src 'self'`, so it cannot reach the blob URL itself); the
/// fetched bytes then go through the SAME fail-closed `SkillInstaller::install_bytes`
/// verify -> re-validate -> compat-gate -> extract -> register -> persist pipeline
/// that the path-based `skill_install` command uses.
#[tauri::command]
async fn skill_download_install(
    args: SkillDownloadInstallArgs,
    client: State<'_, BackendClient>,
    installer: State<'_, SkillInstaller>,
) -> Result<SkillInstallResult, CmdError> {
    let client = client.inner().clone();
    let bytes = client.fetch_bytes(&args.url).await?;
    let outcome = installer
        .install_bytes(&bytes)
        .map_err(|e| CmdError::Package(e.to_string()))?;
    Ok(SkillInstallResult {
        skill_id: outcome.id,
        version: outcome.version,
        dir: outcome.dir.to_string_lossy().into_owned(),
        state: hpskill::state_label(outcome.state).to_string(),
    })
}

/// Task 10 (SPEC §8.5 / §11 — the B4 trust surface): render the plain-language
/// "This skill can: …" install-time capability disclosure. The webview calls
/// this BEFORE an install/buy proceeds, so a shopper sees exactly what a skill
/// can do and can still cancel with no state change. Thin IPC wrapper — all the
/// logic (the closed v1 capability set + the disclosure phrasing) lives in the
/// existing, unit-tested `tool_routing` module; an out-of-set token (only
/// network/file/system are excluded in v1) rejects with `CmdError::InvalidArgs`
/// naming it, never a panic.
#[tauri::command]
fn capability_disclose(args: CapabilityDiscloseArgs) -> Result<String, CmdError> {
    let caps = tool_routing::parse_capabilities(&args.capabilities)
        .map_err(|e| CmdError::InvalidArgs(e.to_string()))?;
    Ok(tool_routing::disclose(&caps))
}

// ---------------------------------------------------------------------------
// Accounts / licensing (P1-09) + step-up (P1-09.8). The Rust core owns the
// session: register/login/refresh/logout hit `/v1/auth` and persist the token
// pair in the T2 SQLite store; `auth_status` reports it. `device_ensure` mints
// the stable install id + keypair AND (P0 fix) a real backend session for a
// still-anonymous install via the email-optional `/v1/auth/register` path, so
// there is a bearer before it also (best-effort) registers a device slot with
// `/v1/devices`; `entitlements_refresh` caches `/v1/entitlements` locally;
// `step_up_answer` signs a server challenge with the persisted device key.
// ---------------------------------------------------------------------------

/// Assemble the account+device status the webview hydrates from. Always resolves
/// the stable install id (minting the local identity on first call), so `deviceId`
/// is present even when signed out.
fn session_status(session: &SessionManager) -> Result<SessionStatus, CmdError> {
    let identity = device::ensure_identity(session.store())?;
    let current = session.current();
    let email = current.as_ref().and_then(|s| s.email.clone());
    let status = match (&current, &email) {
        (None, _) => "anonymous",
        (Some(_), Some(_)) => "authenticated",
        (Some(_), None) => "device",
    };
    Ok(SessionStatus {
        status: status.to_string(),
        authenticated: current.is_some(),
        email,
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
) -> Result<SessionStatus, CmdError> {
    let session = session.inner().clone();
    // Always ensure a local identity exists (install id + keypair + fingerprint).
    let identity = device::ensure_identity(session.store())?;

    // P0 fix (the load-bearing step): a brand-new anonymous install has no
    // backend session at all, so `session.bearer()` is `None` and every authed
    // commerce call (order_checkout/license_fetch/download_url) 401s no matter
    // what this command used to do below. Mint the email-optional "device
    // identity" session — `POST /v1/auth/register` with no credentials — so
    // there is a real bearer to attach. Propagates on failure (an offline
    // backend must surface as a real error, not a silent false "ready").
    // No-op once ANY session (device-only or a full account) already exists.
    session.ensure_device_session().await?;

    // Best-effort: also register this device in the account's device-slot
    // registry (`/v1/devices/register`, step-up gated, 5-slot cap) — a
    // DIFFERENT concern (letting a signed-in-by-email user manage multiple
    // devices), not what buy/download need, so a failure here must never fail
    // the whole command (the webview can retry via another `device_ensure`).
    if !identity.registered {
        if let Some(bearer) = session.bearer().await {
            let name = device::default_device_name();
            let fingerprint = device::fingerprint(&identity);
            if let Ok(dev) = session
                .client()
                .device_register(&name, &fingerprint, Some(&bearer), None)
                .await
            {
                let _ = device::mark_registered(session.store(), &dev.device_id);
            }
        }
    }

    session_status(&session)
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

// ---------------------------------------------------------------------------
// Templates (Task 11a, SPEC §10) — save / list / load a named skill
// combination (the "Weeknight Chef" B2 demo beat). Pure on-device: the Rust
// core (`templates.rs`) validates the combo/version-pin logic; this layer
// persists it in the shared on-device store — the SAME `Arc<Mutex<Store>>`
// `SessionManager` already manages (P1-10), mirroring the `device.rs`
// precedent (a plain fn over `&Arc<Mutex<Store>>`) rather than adding a new
// managed state — and resolves a load against `store.list_installed_skills()`.
//
// Each `#[tauri::command]` below is a thin wrapper over a `*_with_store` fn
// that takes the store directly, so the save/list/load logic is unit-testable
// without any Tauri runtime (see `template_tests` below), the same split
// `capability_disclose` uses for testability.
// ---------------------------------------------------------------------------

/// Flatten a `templates::Template` into the gallery's `TemplateView`.
fn template_view(template: &templates::Template) -> TemplateView {
    TemplateView {
        id: template.id.clone(),
        name: template.name.clone(),
        skill_refs: template.skill_refs.iter().map(|r| r.skill_id.clone()).collect(),
        base_model: template.base_model.clone(),
    }
}

/// **Save current agent as template** (P1-07.2, SPEC §10) over a given store.
fn template_save_with_store(
    args: TemplateSaveArgs,
    store: &Arc<Mutex<Store>>,
) -> Result<TemplateView, CmdError> {
    let mut enabled: Vec<(&str, templates::SemVer)> = Vec::with_capacity(args.skill_refs.len());
    for (skill_id, version) in &args.skill_refs {
        let parsed: templates::SemVer = version.parse().map_err(|e: String| {
            CmdError::InvalidArgs(format!("skill '{skill_id}' has an invalid version '{version}': {e}"))
        })?;
        enabled.push((skill_id.as_str(), parsed));
    }
    let template = templates::save_as_template(&args.name, &args.base_model, &enabled, args.ui_overrides);
    store
        .lock()
        .expect("template store mutex poisoned")
        .save_template(&template)
        .map_err(|e| CmdError::Template(e.to_string()))?;
    Ok(template_view(&template))
}

/// **List saved templates** — the "My Templates" gallery (SPEC §10), over a given store.
fn template_list_with_store(store: &Arc<Mutex<Store>>) -> Result<Vec<TemplateView>, CmdError> {
    let saved = store
        .lock()
        .expect("template store mutex poisoned")
        .list_templates()
        .map_err(|e| CmdError::Template(e.to_string()))?;
    Ok(saved.iter().map(template_view).collect())
}

/// **Load a template** (P1-07.3, SPEC §10) over a given store: resolve it against
/// the store's `installed_skills` versions via `templates::load_template`, and map
/// `TemplateError::MissingSkill`/`VersionIncompatible` into a structured
/// `TemplateLoadResult` — never a bare error (the UI explains and offers reinstall).
///
/// Installed skill versions are stored as strings; an unparseable one can never
/// satisfy a pin, so that skill is treated as not installed for resolution
/// purposes (reported in `missing_skills`, never a panic).
fn template_load_with_store(
    args: TemplateLoadArgs,
    store: &Arc<Mutex<Store>>,
) -> Result<TemplateLoadResult, CmdError> {
    let (template, installed) = {
        let guard = store.lock().expect("template store mutex poisoned");
        let template = guard
            .load_template(&args.id)
            .map_err(|e| CmdError::Template(e.to_string()))?
            .ok_or_else(|| CmdError::InvalidArgs(format!("no such template: {}", args.id)))?;
        let installed =
            guard.list_installed_skills().map_err(|e| CmdError::Template(e.to_string()))?;
        (template, installed)
    };

    let installed_versions: Vec<(&str, templates::SemVer)> = installed
        .iter()
        .filter_map(|s| s.version.parse::<templates::SemVer>().ok().map(|v| (s.skill_id.as_str(), v)))
        .collect();

    Ok(match templates::load_template(&template, &installed_versions) {
        Ok(resolved) => TemplateLoadResult {
            ok: true,
            skill_ids: resolved.skills.into_iter().map(|s| s.skill_id).collect(),
            ui_overrides: resolved.ui_overrides,
            missing_skills: Vec::new(),
        },
        Err(templates::TemplateError::MissingSkill { skill_id })
        | Err(templates::TemplateError::VersionIncompatible { skill_id, .. }) => TemplateLoadResult {
            ok: false,
            skill_ids: Vec::new(),
            ui_overrides: serde_json::Value::Null,
            missing_skills: vec![skill_id],
        },
    })
}

#[tauri::command]
fn template_save(
    args: TemplateSaveArgs,
    session: State<'_, SessionManager>,
) -> Result<TemplateView, CmdError> {
    template_save_with_store(args, session.inner().store())
}

#[tauri::command]
fn template_list(session: State<'_, SessionManager>) -> Result<Vec<TemplateView>, CmdError> {
    template_list_with_store(session.inner().store())
}

#[tauri::command]
fn template_load(
    args: TemplateLoadArgs,
    session: State<'_, SessionManager>,
) -> Result<TemplateLoadResult, CmdError> {
    template_load_with_store(args, session.inner().store())
}

// ---------------------------------------------------------------------------
// UI / panel state (Task 12, SPEC §9) — the IPC counterpart of the Angular
// `StorageBackend` seam's `set`/`get`, over the EXISTING `store.rs`
// `save_panel_state`/`load_panel_state` (no new store logic). Same
// `*_with_store` split as the template commands above, for the same reason:
// testable without a Tauri runtime, and mirroring exactly how
// `template_save`/`template_load` reach the managed store via
// `session.inner().store()`.
// ---------------------------------------------------------------------------

/// **Save UI/panel state** (Task 12, SPEC §9) over a given store.
fn ui_state_save_with_store(args: UiStateSaveArgs, store: &Arc<Mutex<Store>>) -> Result<(), CmdError> {
    store
        .lock()
        .expect("ui state store mutex poisoned")
        .save_panel_state(&args.agent_id, &args.body)
        .map_err(|e| CmdError::UiState(e.to_string()))
}

/// **Load UI/panel state** (Task 12, SPEC §9) over a given store, or `None`
/// when nothing has been saved yet for this agent.
fn ui_state_load_with_store(
    args: UiStateLoadArgs,
    store: &Arc<Mutex<Store>>,
) -> Result<Option<serde_json::Value>, CmdError> {
    store
        .lock()
        .expect("ui state store mutex poisoned")
        .load_panel_state(&args.agent_id)
        .map_err(|e| CmdError::UiState(e.to_string()))
}

#[tauri::command]
fn ui_state_save(args: UiStateSaveArgs, session: State<'_, SessionManager>) -> Result<(), CmdError> {
    ui_state_save_with_store(args, session.inner().store())
}

#[tauri::command]
fn ui_state_load(
    args: UiStateLoadArgs,
    session: State<'_, SessionManager>,
) -> Result<Option<serde_json::Value>, CmdError> {
    ui_state_load_with_store(args, session.inner().store())
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
        // P1-11.2 app auto-update seam. Reads `plugins.updater` (endpoint + minisign
        // pubkey) from tauri.conf.json — both PLACEHOLDERS until the update server +
        // signing key are provisioned, so `check_for_update` fails closed and silent
        // (offline-safe, §18). Config is parsed lazily at `app.updater()`, so
        // registering here with the placeholder config never blocks launch.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tools::AppState::new())
        .manage(inference::CancelRegistry::new())
        .manage(downloader::DownloadManager::new())
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
            let session = SessionManager::new(store.clone(), backend);
            app.manage(session.clone());

            // P1-03.2: the .hpskill installer shares the same on-device store as the
            // session (so installed skills + entitlements live in one database). Its
            // package-signing trust set + host env are pinned from the environment
            // (fail-closed: no pinned key ⇒ every install rejects). It rehydrates the
            // installed-skill lifecycle from the store on construction.
            let skills_root = app.path().app_data_dir()?.join("skills");
            let installer =
                SkillInstaller::from_env(hpskill::host_env_from_env(), skills_root, store);
            app.manage(installer);

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
            check_for_update,
            inference_start,
            inference_cancel,
            downloader::model_download_start,
            downloader::model_download_status,
            downloader::model_download_cancel,
            skill_enable,
            skill_disable,
            skill_install,
            skill_uninstall,
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
            skill_download_install,
            capability_disclose,
            auth_register,
            auth_login,
            auth_logout,
            auth_status,
            device_ensure,
            entitlements_refresh,
            step_up_answer,
            template_save,
            template_list,
            template_load,
            ui_state_save,
            ui_state_load,
            unlock::unlock_redeem,
            unlock::unlock_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Hydropark Tauri application");
}

// ---------------------------------------------------------------------------
// Tests — Task 10 (`capability_disclose`, SPEC §8.5 / §11). The command is a
// thin wrapper (no Tauri `State`), so it is callable directly like any plain
// function; these tests exercise it exactly as the webview would over IPC.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod capability_disclose_tests {
    use super::*;

    fn args(caps: &[&str]) -> CapabilityDiscloseArgs {
        CapabilityDiscloseArgs { capabilities: caps.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn known_capabilities_render_the_disclosure_phrase() {
        let msg = capability_disclose(args(&["timers", "list_management"]))
            .expect("known capabilities must disclose");
        assert_eq!(msg, "This skill can: set timers, manage a list");
    }

    #[test]
    fn every_v1_capability_renders_its_own_phrase() {
        let msg = capability_disclose(args(&[
            "timers",
            "unit_conversion",
            "list_management",
            "calculation",
            "date_math",
        ]))
        .expect("the whole closed set must disclose");
        assert_eq!(
            msg,
            "This skill can: set timers, convert units, manage a list, do calculations, do date math"
        );
    }

    #[test]
    fn empty_capabilities_render_the_graceful_no_special_capabilities_line() {
        let msg = capability_disclose(args(&[])).expect("an empty list is not an error");
        assert_eq!(msg, "This skill uses no special capabilities.");
    }

    #[test]
    fn unknown_capability_is_a_cmderror_not_a_panic() {
        let err = capability_disclose(args(&["network"])).expect_err("out-of-set token must reject");
        let msg = err.to_string();
        assert!(msg.contains("network"), "message must name the offending token: {msg}");
        assert!(msg.contains("v1"), "message must reference the v1 rule: {msg}");
    }

    #[test]
    fn an_out_of_set_token_after_valid_ones_still_rejects_cleanly() {
        // Mirrors tool_routing's short-circuit: the first bad token fails the whole call
        // rather than silently dropping it or panicking.
        let err = capability_disclose(args(&["timers", "system"])).expect_err("system has no variant");
        assert!(err.to_string().contains("system"));
    }
}

// ---------------------------------------------------------------------------
// Tests — Task 11a (templates over IPC, SPEC §10). Exercised directly against
// the `*_with_store` fns (no Tauri runtime needed — mirrors how
// `capability_disclose_tests` above calls the thin command fn directly).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod template_tests {
    use super::*;
    use serde_json::json;

    fn store() -> Arc<Mutex<Store>> {
        Arc::new(Mutex::new(Store::open_in_memory().expect("in-memory store opens + migrates")))
    }

    /// Register a skill as installed at `version` (the resolution set
    /// `template_load_with_store` checks against).
    fn install(store: &Arc<Mutex<Store>>, skill_id: &str, version: &str) {
        let manifest = json!({ "id": skill_id, "version": version });
        store
            .lock()
            .unwrap()
            .save_installed_skill(skill_id, version, &manifest, &format!("/skills/{skill_id}"), true)
            .unwrap();
    }

    fn save_args(name: &str, refs: &[(&str, &str)], ui: serde_json::Value) -> TemplateSaveArgs {
        TemplateSaveArgs {
            name: name.to_string(),
            skill_refs: refs.iter().map(|(id, v)| (id.to_string(), v.to_string())).collect(),
            base_model: "qwen2.5-3b-instruct-q4_k_m".to_string(),
            ui_overrides: ui,
        }
    }

    #[test]
    fn save_list_load_round_trip() {
        let store = store();
        install(&store, "cooking-assistant", "1.2.0");
        install(&store, "nutrition-coach", "1.0.0");

        let ui = json!({ "panel_order": ["timers", "ingredients", "nutrition"] });
        let saved = template_save_with_store(
            save_args(
                "Weeknight Chef",
                &[("cooking-assistant", "1.2.0"), ("nutrition-coach", "1.0.0")],
                ui.clone(),
            ),
            &store,
        )
        .expect("save succeeds");

        assert_eq!(saved.id, "tmpl_weeknight_chef");
        assert_eq!(saved.name, "Weeknight Chef");
        assert_eq!(saved.base_model, "qwen2.5-3b-instruct-q4_k_m");
        assert_eq!(saved.skill_refs, vec!["cooking-assistant".to_string(), "nutrition-coach".to_string()]);

        // list() surfaces the just-saved template.
        let listed = template_list_with_store(&store).expect("list succeeds");
        assert_eq!(listed, vec![saved.clone()]);

        // load() resolves the exact combo + restores the layout verbatim.
        let loaded = template_load_with_store(TemplateLoadArgs { id: saved.id.clone() }, &store)
            .expect("load succeeds");
        assert!(loaded.ok);
        assert_eq!(loaded.skill_ids, vec!["cooking-assistant".to_string(), "nutrition-coach".to_string()]);
        assert_eq!(loaded.ui_overrides, ui);
        assert!(loaded.missing_skills.is_empty());
    }

    #[test]
    fn load_with_missing_skill_is_a_structured_result_not_a_bare_error() {
        let store = store();
        install(&store, "cooking-assistant", "1.2.0");
        // nutrition-coach is deliberately never installed.

        let saved = template_save_with_store(
            save_args(
                "Weeknight Chef",
                &[("cooking-assistant", "1.2.0"), ("nutrition-coach", "1.0.0")],
                json!({}),
            ),
            &store,
        )
        .unwrap();

        let loaded = template_load_with_store(TemplateLoadArgs { id: saved.id }, &store)
            .expect("a missing skill is a structured result, not a rejected Result");
        assert!(!loaded.ok);
        assert_eq!(loaded.missing_skills, vec!["nutrition-coach".to_string()]);
        assert!(loaded.skill_ids.is_empty());
    }

    #[test]
    fn load_with_version_incompatible_skill_is_also_a_structured_result() {
        let store = store();
        // Installed below the `>=1.2.0` pin save_as_template records.
        install(&store, "cooking-assistant", "1.1.0");

        let saved = template_save_with_store(
            save_args("T", &[("cooking-assistant", "1.2.0")], json!({})),
            &store,
        )
        .unwrap();

        let loaded = template_load_with_store(TemplateLoadArgs { id: saved.id }, &store).unwrap();
        assert!(!loaded.ok);
        assert_eq!(loaded.missing_skills, vec!["cooking-assistant".to_string()]);
    }

    #[test]
    fn load_unparseable_installed_version_is_treated_as_missing_not_a_panic() {
        let store = store();
        install(&store, "cooking-assistant", "not-a-version");

        let saved =
            template_save_with_store(save_args("Bad Version", &[("cooking-assistant", "1.0.0")], json!({})), &store)
                .unwrap();

        let loaded = template_load_with_store(TemplateLoadArgs { id: saved.id }, &store).unwrap();
        assert!(!loaded.ok);
        assert_eq!(loaded.missing_skills, vec!["cooking-assistant".to_string()]);
    }

    #[test]
    fn load_unknown_template_id_rejects() {
        let store = store();
        let err = template_load_with_store(TemplateLoadArgs { id: "tmpl_nope".to_string() }, &store)
            .expect_err("an unknown template id is a genuine caller error");
        assert!(err.to_string().contains("tmpl_nope"));
    }

    #[test]
    fn save_with_unparseable_version_rejects_naming_the_skill() {
        let store = store();
        let err = template_save_with_store(
            save_args("T", &[("cooking-assistant", "not-a-version")], json!({})),
            &store,
        )
        .expect_err("an unparseable version must not panic");
        let msg = err.to_string();
        assert!(msg.contains("cooking-assistant"));
    }

    #[test]
    fn empty_list_before_any_save() {
        let store = store();
        assert!(template_list_with_store(&store).unwrap().is_empty());
    }
}

// ---------------------------------------------------------------------------
// Tests — Task 12 (`ui_state_save`/`ui_state_load` over IPC, SPEC §9).
// Exercised directly against the `*_with_store` fns (no Tauri runtime
// needed — mirrors `template_tests` above, which mirrors
// `capability_disclose_tests`).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod ui_state_tests {
    use super::*;
    use serde_json::json;

    fn store() -> Arc<Mutex<Store>> {
        Arc::new(Mutex::new(Store::open_in_memory().expect("in-memory store opens + migrates")))
    }

    #[test]
    fn save_then_load_round_trips_panel_state() {
        let store = store();
        assert_eq!(
            ui_state_load_with_store(UiStateLoadArgs { agent_id: "agent-1".to_string() }, &store).unwrap(),
            None,
            "absent before any save"
        );

        let body = json!({
            "order": ["timers", "ingredients"],
            "panels": [{ "id": "timers", "collapsed": false }]
        });
        ui_state_save_with_store(
            UiStateSaveArgs { agent_id: "agent-1".to_string(), body: body.clone() },
            &store,
        )
        .unwrap();

        let loaded =
            ui_state_load_with_store(UiStateLoadArgs { agent_id: "agent-1".to_string() }, &store).unwrap();
        assert_eq!(loaded, Some(body));
    }

    #[test]
    fn state_is_isolated_per_agent() {
        let store = store();
        ui_state_save_with_store(
            UiStateSaveArgs { agent_id: "agent-1".to_string(), body: json!({ "a": 1 }) },
            &store,
        )
        .unwrap();

        assert_eq!(
            ui_state_load_with_store(UiStateLoadArgs { agent_id: "agent-2".to_string() }, &store).unwrap(),
            None,
            "state does not leak across agents"
        );
    }

    #[test]
    fn saving_again_replaces_the_stored_state() {
        let store = store();
        ui_state_save_with_store(
            UiStateSaveArgs { agent_id: "agent-1".to_string(), body: json!({ "v": 1 }) },
            &store,
        )
        .unwrap();
        ui_state_save_with_store(
            UiStateSaveArgs { agent_id: "agent-1".to_string(), body: json!({ "v": 2 }) },
            &store,
        )
        .unwrap();

        let loaded =
            ui_state_load_with_store(UiStateLoadArgs { agent_id: "agent-1".to_string() }, &store).unwrap();
        assert_eq!(loaded, Some(json!({ "v": 2 })), "upsert replaces, not duplicates");
    }
}
