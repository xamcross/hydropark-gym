//! Backend HTTP client (P1-08.x live-flow wiring).
//!
//! The Rust core owns all network egress — the webview CSP is
//! `connect-src 'self'`, so it cannot talk to the backend directly. Every
//! marketplace / commerce call therefore crosses the IPC boundary as a Tauri
//! command (see `main.rs`) that delegates here. This module issues the actual
//! GET/POST to the backend `/v1/…` routes, attaches an `Authorization: Bearer`
//! header when a token is supplied, and maps the JSON response into the
//! camelCase IPC return types declared in `ipc.rs`.
//!
//! ## Backend wire shape vs. IPC shape
//! The backend serializes **snake_case** JSON (Spring global
//! `property-naming-strategy: SNAKE_CASE`) with its own DTO shapes — a merged
//! skills+bundles catalog feed, `Money { amount, currency }`, cursor pages,
//! etc. The IPC contract the webview consumes is **camelCase** and reshaped
//! (`priceCents`, `hardwareBadge`, …). So the flow is always: decode the
//! backend JSON into a private `wire::*` struct, then map it to the public
//! `ipc::*` type. The URL builders and the decode/map step are split into small
//! pure functions so they are unit-testable without a live server (see the
//! `tests` module) — the `async` methods are thin wrappers that do the I/O and
//! call them.

use serde::{Deserialize, Serialize};

use crate::ipc::{
    CatalogItem, CheckoutResult, DownloadUrlResult, EntitlementItem, LicenseResult, OrderStatusResult,
    SkillDetail,
};

/// Dev default when `HYDROPARK_API_BASE` is unset — the port the local stack
/// (deploy/local) and the README's `curl localhost:8080/v1/catalog` use.
pub const DEFAULT_API_BASE: &str = "http://localhost:8080";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Failure taxonomy for a backend call. Kept distinct so the command layer (and
/// later the webview) can tell a transport failure from a rejected request from
/// a shape mismatch. Converted to `ipc::CmdError::Backend` at the command edge.
#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    /// Transport-level failure: DNS, connect, TLS, timeout, body read.
    #[error("network error: {0}")]
    Network(String),
    /// The backend answered, but with a non-2xx status. Carries the raw body so
    /// the structured `{ error: { code, message } }` envelope is not discarded.
    #[error("backend returned HTTP {status}: {body}")]
    Status { status: u16, body: String },
    /// A 2xx body that did not match the expected shape.
    #[error("could not decode backend response: {0}")]
    Decode(String),
    /// F04: `fetch_bytes` was asked to fetch a URL that failed the
    /// `fetch_guard::allowed_fetch_url` scheme/host check — rejected before
    /// any network call was made. Carries the guard's own message, never the
    /// rejected URL's response body (there is none — no request was sent).
    #[error("fetch URL rejected: {0}")]
    DisallowedUrl(String),
}

impl BackendError {
    fn network(e: reqwest::Error) -> Self {
        BackendError::Network(e.to_string())
    }
    fn decode(e: serde_json::Error) -> Self {
        BackendError::Decode(e.to_string())
    }
}

impl From<BackendError> for crate::ipc::CmdError {
    fn from(e: BackendError) -> Self {
        crate::ipc::CmdError::Backend(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Base URL + URL builders (pure)
// ---------------------------------------------------------------------------

/// Resolve the API base from an already-read env value. Split from `base_url`
/// so it is testable without touching process env (which is racy under the test
/// harness). An empty/whitespace value falls back to the dev default.
fn resolve_base(var: Option<String>) -> String {
    match var {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => DEFAULT_API_BASE.to_string(),
    }
}

/// Read `HYDROPARK_API_BASE`, defaulting to [`DEFAULT_API_BASE`].
pub fn base_url() -> String {
    resolve_base(std::env::var("HYDROPARK_API_BASE").ok())
}

/// Join a base and a path with exactly one `/` between them, tolerating a
/// trailing slash on the base and/or a leading slash on the path.
fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

fn catalog_route(base: &str, region: Option<&str>) -> String {
    let url = join(base, "/v1/catalog");
    match region.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => format!("{url}?region={r}"),
        None => url,
    }
}

fn catalog_detail_route(base: &str, skill_id: &str) -> String {
    join(base, &format!("/v1/catalog/skills/{skill_id}"))
}

fn checkout_route(base: &str) -> String {
    join(base, "/v1/orders/checkout")
}

fn order_route(base: &str, order_id: &str) -> String {
    join(base, &format!("/v1/orders/{order_id}"))
}

fn entitlements_route(base: &str) -> String {
    join(base, "/v1/entitlements")
}

fn license_route(base: &str) -> String {
    join(base, "/v1/licenses/issue")
}

fn download_route(base: &str, skill_id: &str, version: &str) -> String {
    join(base, &format!("/v1/download/skills/{skill_id}/{version}"))
}

// --- accounts / devices (P1-09.x) ------------------------------------------

fn auth_register_route(base: &str) -> String {
    join(base, "/v1/auth/register")
}

fn auth_login_route(base: &str) -> String {
    join(base, "/v1/auth/login")
}

fn auth_refresh_route(base: &str) -> String {
    join(base, "/v1/auth/refresh")
}

fn auth_logout_route(base: &str) -> String {
    join(base, "/v1/auth/logout")
}

fn device_register_route(base: &str) -> String {
    join(base, "/v1/devices/register")
}

/// Human-readable hardware badge derived from a skill's required model tier
/// (mirrors the tier vocabulary in `skill_manager.rs`). Unknown/absent tiers
/// read as "runs anywhere" so an unrecognised value never *over*states the
/// requirement.
fn hardware_badge(min_model_tier: Option<&str>) -> String {
    let label = match min_model_tier.map(|t| t.trim().to_ascii_lowercase()).as_deref() {
        Some("small") | Some("s") => "Runs on most PCs",
        Some("mid") | Some("medium") | Some("m") => "Needs a mid-range PC",
        Some("large") | Some("l") => "Needs a high-end PC",
        _ => "Runs on any device",
    };
    label.to_string()
}

// ---------------------------------------------------------------------------
// Request bodies (pure, serialized to the backend's snake_case shape)
// ---------------------------------------------------------------------------

/// `POST /v1/orders/checkout` body for a Merchant-of-Record skill purchase
/// (`kind=skill`, `payment_source=mor`). The backend derives price server-side;
/// amount/currency are omitted (they are honoured only for `wallet_topup`).
#[derive(Debug, Serialize)]
struct CheckoutBody<'a> {
    kind: &'a str,
    target_id: &'a str,
    payment_source: &'a str,
    region: &'a str,
}

fn checkout_body<'a>(target_id: &'a str, region: &'a str) -> CheckoutBody<'a> {
    CheckoutBody { kind: "skill", target_id, payment_source: "mor", region }
}

/// `POST /v1/licenses/issue` body: `{ skill_id, device_id }`. `device_id` is the
/// caller-supplied stable install id from `device.rs` (bound at issuance, never
/// re-derived offline to verify — §13.12), falling back to `HYDROPARK_DEVICE_ID`
/// only before a local identity has been minted.
#[derive(Debug, Serialize)]
struct LicenseBody<'a> {
    skill_id: &'a str,
    device_id: &'a str,
}

fn license_body<'a>(skill_id: &'a str, device_id: &'a str) -> LicenseBody<'a> {
    LicenseBody { skill_id, device_id }
}

/// Legacy fallback device id (pre-`device.rs`): the persisted install id is now
/// the real source (passed in by the command layer). Kept only for the case where
/// no local identity has been minted yet.
fn env_device_id() -> String {
    std::env::var("HYDROPARK_DEVICE_ID").unwrap_or_default()
}

// --- accounts / devices (P1-09.x) — snake_case request bodies --------------

/// `POST /v1/auth/register` and `/v1/auth/login` both take `{ email, password }`.
#[derive(Debug, Serialize)]
struct CredentialsBody<'a> {
    email: &'a str,
    password: &'a str,
}

/// `POST /v1/auth/refresh` and `/v1/auth/logout` both take `{ refresh_token }`.
#[derive(Debug, Serialize)]
struct RefreshTokenBody<'a> {
    refresh_token: &'a str,
}

/// `POST /v1/devices/register` body: `{ name, fingerprint }`. The coarse
/// fingerprint is stored server-side as-is and never re-derived offline (§13.12).
#[derive(Debug, Serialize)]
struct DeviceRegisterBody<'a> {
    name: &'a str,
    fingerprint: &'a str,
}

// ---------------------------------------------------------------------------
// Backend wire shapes (private) — snake_case, mirror the Java DTOs
// ---------------------------------------------------------------------------

mod wire {
    use super::Deserialize;

    #[derive(Debug, Deserialize)]
    pub struct Money {
        pub amount: i64,
        #[allow(dead_code)]
        pub currency: String,
    }

    #[derive(Debug, Deserialize)]
    pub struct Requirements {
        #[serde(default)]
        pub min_model_tier: Option<String>,
        #[serde(default)]
        #[allow(dead_code)]
        pub min_app_version: Option<String>,
    }

    /// One row of `GET /v1/catalog` (CatalogItemDto). Skills and bundles share
    /// this shape; bundle rows carry null category/size/requirements.
    #[derive(Debug, Deserialize)]
    pub struct CatalogItem {
        pub id: String,
        pub name: String,
        #[serde(default)]
        pub pitch: Option<String>,
        #[serde(default)]
        pub category: Option<String>,
        #[serde(default)]
        pub price: Option<Money>,
        #[serde(default)]
        pub is_free: bool,
        #[serde(default)]
        pub requirements: Option<Requirements>,
        #[serde(default)]
        pub size: Option<i64>,
        #[serde(default)]
        pub owned: Option<bool>,
    }

    /// `GET /v1/catalog` is cursor-paginated: `{ items, next_cursor }`. We take
    /// `items` only (the live-flow catalog command is not paginated).
    #[derive(Debug, Deserialize)]
    pub struct CatalogPage {
        pub items: Vec<CatalogItem>,
    }

    #[derive(Debug, Deserialize)]
    pub struct SkillVersion {
        pub version: String,
        #[serde(default)]
        pub size: Option<i64>,
    }

    /// `GET /v1/catalog/skills/{id}` (SkillDetailDto).
    #[derive(Debug, Deserialize)]
    pub struct SkillDetail {
        pub id: String,
        pub name: String,
        #[serde(default)]
        pub pitch: Option<String>,
        #[serde(default)]
        pub category: Option<String>,
        #[serde(default)]
        pub is_free: bool,
        pub status: String,
        #[serde(default)]
        pub price: Option<Money>,
        #[serde(default)]
        pub compressed_prompt: Option<String>,
        #[serde(default)]
        pub has_preview: bool,
        #[serde(default)]
        pub min_model_tier: Option<String>,
        #[serde(default)]
        pub requirements: Option<Requirements>,
        #[serde(default)]
        pub current_version: Option<SkillVersion>,
        #[serde(default)]
        pub changelog: Option<String>,
        #[serde(default)]
        pub owned: Option<bool>,
        /// F05: the manifest-derived capability-token array (SkillDetailDto.capabilities).
        /// Defaulted so a backend that predates this field still decodes.
        #[serde(default)]
        pub capabilities: Vec<String>,
    }

    /// `POST /v1/orders/checkout` (CheckoutResponse). `checkout_url` is null for
    /// the wallet-funded path; the MoR path this client uses always sets it.
    #[derive(Debug, Deserialize)]
    pub struct Checkout {
        pub order_id: String,
        #[serde(default)]
        pub checkout_url: Option<String>,
    }

    /// `GET /v1/orders/{id}` (OrderView) — we surface id + status only.
    #[derive(Debug, Deserialize)]
    pub struct Order {
        pub order_id: String,
        pub status: String,
    }

    /// One row of `GET /v1/entitlements` (EntitlementView).
    #[derive(Debug, Deserialize)]
    pub struct Entitlement {
        pub skill_id: String,
        pub status: String,
    }

    /// `POST /v1/licenses/issue` (IssueResponse) — `token` is the compact JWS.
    #[derive(Debug, Deserialize)]
    pub struct License {
        pub token: String,
    }

    /// `GET /v1/download/skills/{id}/{ver}` (SkillDownloadResponse). `expires_at`
    /// is an ISO-8601 instant string on the wire.
    #[derive(Debug, Deserialize)]
    pub struct Download {
        pub url: String,
        pub expires_at: String,
        pub watermark: String,
    }

    /// The `user` sub-object of an `AuthResponse` (register/login).
    #[derive(Debug, Deserialize)]
    pub struct AuthUser {
        #[allow(dead_code)]
        pub id: String,
        #[serde(default)]
        pub email: Option<String>,
    }

    /// `POST /v1/auth/register|login` (AuthResponse). `recovery_code` is present
    /// only for a device-only registration; we do not surface it here.
    #[derive(Debug, Deserialize)]
    pub struct AuthResponse {
        pub access_jwt: String,
        pub refresh_token: String,
        #[serde(default)]
        pub user: Option<AuthUser>,
    }

    /// `POST /v1/auth/refresh` (TokenPair) — rotated tokens, no user echo.
    #[derive(Debug, Deserialize)]
    pub struct TokenPair {
        pub access_jwt: String,
        pub refresh_token: String,
    }

    /// `POST /v1/devices/register` (DeviceView) — the client-facing slot. Omits
    /// the fingerprint (server-side only); we surface id + status.
    #[derive(Debug, Deserialize)]
    pub struct DeviceView {
        pub id: String,
        pub status: String,
    }
}

// ---------------------------------------------------------------------------
// Decode + map helpers (pure) — backend JSON string -> IPC type
// ---------------------------------------------------------------------------

fn price_cents(is_free: bool, price: &Option<wire::Money>) -> i64 {
    if is_free {
        0
    } else {
        price.as_ref().map(|m| m.amount).unwrap_or(0)
    }
}

fn map_catalog_item(w: wire::CatalogItem) -> CatalogItem {
    let price_cents = price_cents(w.is_free, &w.price);
    let badge = hardware_badge(
        w.requirements.as_ref().and_then(|r| r.min_model_tier.as_deref()),
    );
    CatalogItem {
        id: w.id,
        name: w.name,
        pitch: w.pitch,
        category: w.category,
        price_cents,
        size_bytes: w.size,
        hardware_badge: badge,
        ownership: w.owned,
    }
}

fn decode_catalog(json: &str) -> Result<Vec<CatalogItem>, BackendError> {
    let page: wire::CatalogPage = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(page.items.into_iter().map(map_catalog_item).collect())
}

fn map_skill_detail(w: wire::SkillDetail) -> SkillDetail {
    let price = price_cents(w.is_free, &w.price);
    // Prefer the detail-level tier; fall back to requirements.min_model_tier.
    let tier = w
        .min_model_tier
        .as_deref()
        .or_else(|| w.requirements.as_ref().and_then(|r| r.min_model_tier.as_deref()));
    let badge = hardware_badge(tier);
    let size_bytes = w.current_version.as_ref().and_then(|v| v.size);
    let current_version = w.current_version.as_ref().map(|v| v.version.clone());
    SkillDetail {
        id: w.id,
        name: w.name,
        pitch: w.pitch,
        category: w.category,
        price_cents: price,
        is_free: w.is_free,
        status: w.status,
        compressed_prompt: w.compressed_prompt,
        has_preview: w.has_preview,
        min_model_tier: w.min_model_tier,
        hardware_badge: badge,
        size_bytes,
        current_version,
        changelog: w.changelog,
        ownership: w.owned,
        capabilities: w.capabilities,
    }
}

fn decode_skill_detail(json: &str) -> Result<SkillDetail, BackendError> {
    let w: wire::SkillDetail = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(map_skill_detail(w))
}

fn decode_checkout(json: &str) -> Result<CheckoutResult, BackendError> {
    let w: wire::Checkout = serde_json::from_str(json).map_err(BackendError::decode)?;
    let checkout_url = w.checkout_url.ok_or_else(|| {
        BackendError::Decode("checkout response carried no checkout_url".to_string())
    })?;
    Ok(CheckoutResult { order_id: w.order_id, checkout_url })
}

fn decode_order(json: &str) -> Result<OrderStatusResult, BackendError> {
    let w: wire::Order = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(OrderStatusResult { order_id: w.order_id, status: w.status })
}

fn decode_entitlements(json: &str) -> Result<Vec<EntitlementItem>, BackendError> {
    let rows: Vec<wire::Entitlement> =
        serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(rows
        .into_iter()
        .map(|w| EntitlementItem { skill_id: w.skill_id, status: w.status })
        .collect())
}

fn decode_license(json: &str) -> Result<LicenseResult, BackendError> {
    let w: wire::License = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(LicenseResult { compact_jws: w.token })
}

fn decode_download(json: &str) -> Result<DownloadUrlResult, BackendError> {
    let w: wire::Download = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(DownloadUrlResult { url: w.url, expires_at: w.expires_at, watermark: w.watermark })
}

// --- accounts / devices (P1-09.x) ------------------------------------------

/// A freshly-issued (or rotated) session token pair. `email` is carried through
/// on register/login (from the response's `user`); a bare refresh yields `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSession {
    pub access_token: String,
    pub refresh_token: String,
    pub email: Option<String>,
}

/// The outcome of a device registration: the server-assigned device id + status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredDevice {
    pub device_id: String,
    pub status: String,
}

fn decode_auth_response(json: &str) -> Result<AuthSession, BackendError> {
    let w: wire::AuthResponse = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(AuthSession {
        access_token: w.access_jwt,
        refresh_token: w.refresh_token,
        email: w.user.and_then(|u| u.email),
    })
}

fn decode_token_pair(json: &str) -> Result<AuthSession, BackendError> {
    let w: wire::TokenPair = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(AuthSession { access_token: w.access_jwt, refresh_token: w.refresh_token, email: None })
}

fn decode_device(json: &str) -> Result<RegisteredDevice, BackendError> {
    let w: wire::DeviceView = serde_json::from_str(json).map_err(BackendError::decode)?;
    Ok(RegisteredDevice { device_id: w.id, status: w.status })
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// Cheaply cloneable (`reqwest::Client` is an `Arc` internally). Registered
/// once via `.manage()` in `main.rs`; each command clones it out of `State`
/// before awaiting so no `State` borrow is held across an `.await`.
#[derive(Clone)]
pub struct BackendClient {
    http: reqwest::Client,
    base: String,
}

impl Default for BackendClient {
    fn default() -> Self {
        Self::new()
    }
}

impl BackendClient {
    /// Build with the base URL from `HYDROPARK_API_BASE` (or the dev default).
    pub fn new() -> Self {
        Self { http: crate::fetch_guard::build_http_client(), base: base_url() }
    }

    /// Build against an explicit base URL (used by tests / callers that already
    /// resolved the base).
    #[allow(dead_code)]
    pub fn with_base(base: impl Into<String>) -> Self {
        Self { http: crate::fetch_guard::build_http_client(), base: base.into() }
    }

    // --- catalog (PUBLIC — no bearer) --------------------------------------

    pub async fn catalog_list(
        &self,
        region: Option<&str>,
    ) -> Result<Vec<CatalogItem>, BackendError> {
        let url = catalog_route(&self.base, region);
        let resp = self.http.get(&url).send().await.map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_catalog(&body)
    }

    pub async fn catalog_detail(&self, skill_id: &str) -> Result<SkillDetail, BackendError> {
        let url = catalog_detail_route(&self.base, skill_id);
        let resp = self.http.get(&url).send().await.map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_skill_detail(&body)
    }

    // --- orders / entitlements / license / download (optional bearer) ------

    pub async fn order_checkout(
        &self,
        target_id: &str,
        region: &str,
        bearer: Option<&str>,
    ) -> Result<CheckoutResult, BackendError> {
        let url = checkout_route(&self.base);
        let req = with_bearer(self.http.post(&url).json(&checkout_body(target_id, region)), bearer);
        let resp = req.send().await.map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_checkout(&body)
    }

    pub async fn order_get(
        &self,
        order_id: &str,
        bearer: Option<&str>,
    ) -> Result<OrderStatusResult, BackendError> {
        let url = order_route(&self.base, order_id);
        let resp = with_bearer(self.http.get(&url), bearer)
            .send()
            .await
            .map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_order(&body)
    }

    pub async fn entitlements_get(
        &self,
        bearer: Option<&str>,
    ) -> Result<Vec<EntitlementItem>, BackendError> {
        let url = entitlements_route(&self.base);
        let resp = with_bearer(self.http.get(&url), bearer)
            .send()
            .await
            .map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_entitlements(&body)
    }

    pub async fn license_fetch(
        &self,
        skill_id: &str,
        bearer: Option<&str>,
        device_id: Option<&str>,
    ) -> Result<LicenseResult, BackendError> {
        let url = license_route(&self.base);
        // Prefer the persisted install id (passed by the command layer); fall back
        // to the legacy env var only when no local identity has been minted yet.
        let device = device_id
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .unwrap_or_else(env_device_id);
        let req = with_bearer(
            self.http.post(&url).json(&license_body(skill_id, &device)),
            bearer,
        );
        let resp = req.send().await.map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_license(&body)
    }

    pub async fn download_url(
        &self,
        skill_id: &str,
        version: &str,
        bearer: Option<&str>,
    ) -> Result<DownloadUrlResult, BackendError> {
        let url = download_route(&self.base, skill_id, version);
        let resp = with_bearer(self.http.get(&url), bearer)
            .send()
            .await
            .map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_download(&body)
    }

    /// Fetch raw bytes from an absolute URL — used for the signed `.hpskill` blob
    /// URL `download_url` returns (the bridge into `skill_download_install`,
    /// P1-03.2). Unlike every other method here this does NOT join against
    /// `self.base`: the URL is already absolute. No bearer is attached — the URL
    /// is pre-signed and self-authorizing.
    ///
    /// F04: `url` arrives over IPC straight from the webview (Tauri commands here
    /// are not ACL-gated — `capabilities/default.json`), so before this does
    /// anything network-facing it is checked by
    /// [`crate::fetch_guard::allowed_fetch_url`] against the configured backend
    /// origin (see that module's doc for why that origin is the only legitimate
    /// target). A rejected URL never reaches `self.http` — no DNS lookup, no
    /// connection, nothing an attacker-chosen loopback/internal host could
    /// observe. On a non-2xx from an *allowed* host the response body is also
    /// NOT echoed into the error (a prior version did, which turned a rejected
    /// fetch into a response-body oracle) — only the status code crosses back to
    /// the webview; the raw body is logged Rust-side only.
    pub async fn fetch_bytes(&self, url: &str) -> Result<Vec<u8>, BackendError> {
        let checked = crate::fetch_guard::allowed_fetch_url(url, &self.base)
            .map_err(|e| BackendError::DisallowedUrl(e.to_string()))?;
        let resp = self.http.get(checked).send().await.map_err(BackendError::network)?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(BackendError::network)?;
        if status.is_success() {
            Ok(bytes.to_vec())
        } else {
            // F04: log the real body Rust-side only — never surface it to the webview.
            eprintln!(
                "fetch_bytes: backend returned HTTP {} for an allowed URL (body suppressed from caller, {} bytes)",
                status.as_u16(),
                bytes.len()
            );
            Err(BackendError::Status { status: status.as_u16(), body: String::new() })
        }
    }

    // --- accounts / devices (P1-09.x) --------------------------------------

    pub async fn auth_register(
        &self,
        email: &str,
        password: &str,
    ) -> Result<AuthSession, BackendError> {
        let url = auth_register_route(&self.base);
        let resp = self
            .http
            .post(&url)
            .json(&CredentialsBody { email, password })
            .send()
            .await
            .map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_auth_response(&body)
    }

    pub async fn auth_login(
        &self,
        email: &str,
        password: &str,
    ) -> Result<AuthSession, BackendError> {
        let url = auth_login_route(&self.base);
        let resp = self
            .http
            .post(&url)
            .json(&CredentialsBody { email, password })
            .send()
            .await
            .map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_auth_response(&body)
    }

    pub async fn auth_refresh(&self, refresh_token: &str) -> Result<AuthSession, BackendError> {
        let url = auth_refresh_route(&self.base);
        let resp = self
            .http
            .post(&url)
            .json(&RefreshTokenBody { refresh_token })
            .send()
            .await
            .map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_token_pair(&body)
    }

    /// `POST /v1/auth/logout` — revokes the refresh token server-side (204 body).
    pub async fn auth_logout(&self, refresh_token: &str) -> Result<(), BackendError> {
        let url = auth_logout_route(&self.base);
        let resp = self
            .http
            .post(&url)
            .json(&RefreshTokenBody { refresh_token })
            .send()
            .await
            .map_err(BackendError::network)?;
        read_ok(resp).await?; // 2xx (204) → empty body; non-2xx → Status error
        Ok(())
    }

    /// `POST /v1/devices/register`. Requires a bearer; the first device an account
    /// binds is trusted-on-first-use server-side, so `step_up_token` is normally
    /// `None` and only supplied for a later device (BE §8).
    pub async fn device_register(
        &self,
        name: &str,
        fingerprint: &str,
        bearer: Option<&str>,
        step_up_token: Option<&str>,
    ) -> Result<RegisteredDevice, BackendError> {
        let url = device_register_route(&self.base);
        let mut req = with_bearer(
            self.http.post(&url).json(&DeviceRegisterBody { name, fingerprint }),
            bearer,
        );
        if let Some(token) = step_up_token.map(str::trim).filter(|t| !t.is_empty()) {
            req = req.header("X-Step-Up-Token", token);
        }
        let resp = req.send().await.map_err(BackendError::network)?;
        let body = read_ok(resp).await?;
        decode_device(&body)
    }
}

/// Attach `Authorization: Bearer <token>` when a non-empty token is supplied.
fn with_bearer(rb: reqwest::RequestBuilder, bearer: Option<&str>) -> reqwest::RequestBuilder {
    match bearer.map(str::trim).filter(|t| !t.is_empty()) {
        Some(token) => rb.bearer_auth(token),
        None => rb,
    }
}

/// Read a response body, turning a non-2xx status into [`BackendError::Status`]
/// (keeping the body, which is the backend's structured error envelope).
async fn read_ok(resp: reqwest::Response) -> Result<String, BackendError> {
    let status = resp.status();
    let body = resp.text().await.map_err(BackendError::network)?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(BackendError::Status { status: status.as_u16(), body })
    }
}

// ---------------------------------------------------------------------------
// Test-only loopback HTTP stub (P1-03.2 download+install flow proof)
// ---------------------------------------------------------------------------

/// A minimal, single-request loopback HTTP stub used ONLY by tests — this file's
/// `fetch_bytes` tests, and `hpskill.rs`'s download-then-install flow test. No mock-
/// server crate needed: binds an ephemeral `127.0.0.1` port, accepts exactly one
/// connection on a background thread, discards the request, and writes back
/// `status_line` + `body`. Returns the `http://127.0.0.1:<port>/pkg` URL to fetch.
/// Loopback-only — this never touches the real network, so it is deterministic and
/// safe under `cargo test` (it does NOT hit the live backend).
#[cfg(test)]
pub(crate) fn spawn_stub_server(status_line: &'static str, body: Vec<u8>) -> String {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("local_addr").port();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf); // drain the request line/headers; content unused
            let header = format!(
                "{status_line}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        }
    });
    format!("http://127.0.0.1:{port}/pkg")
}

/// Like [`spawn_stub_server`] but adds a `Location:` header — used only by the
/// F04-follow-up redirect test to prove the client's no-redirect policy
/// (`fetch_guard::build_http_client`) actually stops a `3xx` answered by an
/// ALLOWLISTED host from being followed to wherever `location` points.
#[cfg(test)]
pub(crate) fn spawn_redirect_stub_server(
    status_line: &'static str,
    location: &'static str,
    body: Vec<u8>,
) -> String {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("local_addr").port();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf); // drain the request line/headers; content unused
            let header = format!(
                "{status_line}\r\nLocation: {location}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        }
    });
    format!("http://127.0.0.1:{port}/pkg")
}

// ---------------------------------------------------------------------------
// Tests — pure helpers only, EXCEPT `fetch_bytes*` below, which round-trips a
// local loopback stub (see `spawn_stub_server`) rather than the real network.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "http://api.example";

    #[test]
    fn resolve_base_falls_back_to_default() {
        assert_eq!(resolve_base(None), DEFAULT_API_BASE);
        assert_eq!(resolve_base(Some("   ".to_string())), DEFAULT_API_BASE);
        assert_eq!(resolve_base(Some(String::new())), DEFAULT_API_BASE);
        assert_eq!(resolve_base(Some("http://x:9".to_string())), "http://x:9");
    }

    #[test]
    fn join_normalizes_slashes() {
        assert_eq!(join("http://x", "/v1/catalog"), "http://x/v1/catalog");
        assert_eq!(join("http://x/", "/v1/catalog"), "http://x/v1/catalog");
        assert_eq!(join("http://x/", "v1/catalog"), "http://x/v1/catalog");
    }

    #[test]
    fn catalog_route_appends_region_query() {
        assert_eq!(catalog_route(BASE, None), "http://api.example/v1/catalog");
        assert_eq!(catalog_route(BASE, Some("")), "http://api.example/v1/catalog");
        assert_eq!(catalog_route(BASE, Some("  ")), "http://api.example/v1/catalog");
        assert_eq!(
            catalog_route(BASE, Some("US")),
            "http://api.example/v1/catalog?region=US"
        );
    }

    #[test]
    fn routes_are_built_correctly() {
        assert_eq!(
            catalog_detail_route(BASE, "home-diy"),
            "http://api.example/v1/catalog/skills/home-diy"
        );
        assert_eq!(checkout_route(BASE), "http://api.example/v1/orders/checkout");
        assert_eq!(order_route(BASE, "ord_1"), "http://api.example/v1/orders/ord_1");
        assert_eq!(entitlements_route(BASE), "http://api.example/v1/entitlements");
        assert_eq!(license_route(BASE), "http://api.example/v1/licenses/issue");
        assert_eq!(
            download_route(BASE, "home-diy", "1.4.2"),
            "http://api.example/v1/download/skills/home-diy/1.4.2"
        );
    }

    #[test]
    fn checkout_body_is_a_mor_skill_purchase() {
        let v = serde_json::to_value(checkout_body("home-diy", "US")).unwrap();
        assert_eq!(v["kind"], "skill");
        assert_eq!(v["payment_source"], "mor");
        assert_eq!(v["target_id"], "home-diy");
        assert_eq!(v["region"], "US");
        // amount/currency are never sent for a skill purchase (server-derived price).
        assert!(v.get("amount").is_none());
        assert!(v.get("currency").is_none());
    }

    #[test]
    fn license_body_carries_skill_and_device() {
        let v = serde_json::to_value(license_body("home-diy", "dev-123")).unwrap();
        assert_eq!(v["skill_id"], "home-diy");
        assert_eq!(v["device_id"], "dev-123");
    }

    #[test]
    fn hardware_badge_maps_known_tiers() {
        assert_eq!(hardware_badge(Some("small")), "Runs on most PCs");
        assert_eq!(hardware_badge(Some("S")), "Runs on most PCs");
        assert_eq!(hardware_badge(Some("mid")), "Needs a mid-range PC");
        assert_eq!(hardware_badge(Some("medium")), "Needs a mid-range PC");
        assert_eq!(hardware_badge(Some("large")), "Needs a high-end PC");
        assert_eq!(hardware_badge(None), "Runs on any device");
        assert_eq!(hardware_badge(Some("wat")), "Runs on any device");
    }

    #[test]
    fn decode_catalog_maps_price_size_badge_and_ownership() {
        // A merged skills+bundles page: a priced skill, a free skill, and a
        // bundle row with null category/size/requirements.
        let json = r#"{
          "items": [
            {
              "kind": "skill", "id": "home-diy", "name": "Home DIY",
              "category": "home", "price": { "amount": 500, "currency": "USD" },
              "is_free": false,
              "requirements": { "min_model_tier": "mid", "min_app_version": null },
              "size": 12345678, "current_version": "1.4.2", "owned": false,
              "pitch": "Fix it yourself"
            },
            {
              "kind": "skill", "id": "kitchen-timer", "name": "Kitchen Timer",
              "category": "kitchen", "price": { "amount": 0, "currency": "USD" },
              "is_free": true,
              "requirements": { "min_model_tier": "small", "min_app_version": null },
              "size": 2048, "current_version": "1.0.0", "owned": null
            },
            {
              "kind": "bundle", "id": "home-starter-pack", "name": "Home Starter Pack",
              "category": null, "price": { "amount": 1200, "currency": "USD" },
              "is_free": false, "requirements": null, "size": null,
              "current_version": null, "owned": null
            }
          ],
          "next_cursor": null
        }"#;

        let items = decode_catalog(json).expect("decodes");
        assert_eq!(items.len(), 3);

        let diy = &items[0];
        assert_eq!(diy.id, "home-diy");
        assert_eq!(diy.pitch.as_deref(), Some("Fix it yourself"));
        assert_eq!(diy.price_cents, 500);
        assert_eq!(diy.size_bytes, Some(12345678));
        assert_eq!(diy.hardware_badge, "Needs a mid-range PC");
        assert_eq!(diy.ownership, Some(false));

        let free = &items[1];
        assert_eq!(free.price_cents, 0, "is_free forces priceCents to 0");
        assert_eq!(free.hardware_badge, "Runs on most PCs");
        assert_eq!(free.ownership, None, "null owned = anonymous/unknown");

        let bundle = &items[2];
        assert_eq!(bundle.category, None);
        assert_eq!(bundle.size_bytes, None);
        assert_eq!(bundle.hardware_badge, "Runs on any device");
        assert_eq!(bundle.price_cents, 1200);
    }

    #[test]
    fn decode_catalog_serializes_to_camelcase_ipc_shape() {
        let json = r#"{"items":[{"id":"a","name":"A","is_free":true,
            "requirements":{"min_model_tier":"small"},"size":10,"owned":true}],
            "next_cursor":null}"#;
        let items = decode_catalog(json).unwrap();
        let v = serde_json::to_value(&items[0]).unwrap();
        // The IPC boundary is camelCase, unlike the snake_case backend wire.
        assert_eq!(v["priceCents"], 0);
        assert_eq!(v["sizeBytes"], 10);
        assert_eq!(v["hardwareBadge"], "Runs on most PCs");
        assert_eq!(v["ownership"], true);
        assert!(v.get("price_cents").is_none());
    }

    #[test]
    fn decode_skill_detail_reshapes_current_version_and_prompt() {
        let json = r#"{
          "id": "home-diy", "name": "Home DIY", "category": "home",
          "is_free": false, "status": "published",
          "price": { "amount": 500, "currency": "USD" },
          "compressed_prompt": "You help with DIY tasks.",
          "has_preview": true, "min_model_tier": "mid",
          "requirements": { "min_model_tier": "mid", "min_app_version": "1.0.0" },
          "current_version": {
            "version": "1.4.2", "min_app_version": "1.0.0", "size": 999,
            "sha256": "deadbeef", "is_current": true, "changelog": "fixes",
            "status": "published"
          },
          "changelog": "fixes", "owned": true,
          "capabilities": ["calculation", "unit_conversion", "list_management", "timers", "date_math"]
        }"#;

        let d = decode_skill_detail(json).expect("decodes");
        assert_eq!(d.id, "home-diy");
        assert_eq!(d.price_cents, 500);
        assert_eq!(d.compressed_prompt.as_deref(), Some("You help with DIY tasks."));
        assert!(d.has_preview);
        assert_eq!(d.current_version.as_deref(), Some("1.4.2"));
        assert_eq!(d.size_bytes, Some(999));
        assert_eq!(d.hardware_badge, "Needs a mid-range PC");
        assert_eq!(d.ownership, Some(true));
        assert_eq!(
            d.capabilities,
            vec!["calculation", "unit_conversion", "list_management", "timers", "date_math"]
        );
    }

    /// F05: a real skill's capability tokens must reach the IPC `SkillDetail` the
    /// capability-consent dialog's input is built from — this is the RED/GREEN case
    /// that was missing before the fix (a real detail always yielded `capabilities: []`,
    /// so the disclosure dialog fell back to "This skill uses no special capabilities."
    /// for every skill).
    #[test]
    fn decode_skill_detail_carries_capabilities_onto_the_ipc_shape() {
        let json = r#"{
          "id": "cooking-assistant", "name": "Cooking Assistant", "category": "kitchen",
          "is_free": false, "status": "published",
          "price": { "amount": 500, "currency": "USD" },
          "has_preview": false,
          "capabilities": ["timers", "unit_conversion", "list_management"]
        }"#;

        let d = decode_skill_detail(json).expect("decodes");
        assert_eq!(d.capabilities, vec!["timers", "unit_conversion", "list_management"]);

        // Round-trips onto the camelCase IPC wire (the webview's actual input shape).
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["capabilities"], serde_json::json!(["timers", "unit_conversion", "list_management"]));
    }

    /// A backend response with no `capabilities` key (predates F05, or a bundle/legacy row)
    /// must decode to an empty list, never fail to decode.
    #[test]
    fn decode_skill_detail_defaults_capabilities_to_empty_when_absent() {
        let json = r#"{
          "id": "legacy-skill", "name": "Legacy Skill", "category": "home",
          "is_free": false, "status": "published",
          "price": { "amount": 500, "currency": "USD" },
          "has_preview": false
        }"#;

        let d = decode_skill_detail(json).expect("decodes even with no capabilities key");
        assert!(d.capabilities.is_empty());
    }

    #[test]
    fn decode_checkout_extracts_order_and_url() {
        let json = r#"{"order_id":"ord_1","checkout_url":"https://pay.example/s/abc"}"#;
        let r = decode_checkout(json).unwrap();
        assert_eq!(r.order_id, "ord_1");
        assert_eq!(r.checkout_url, "https://pay.example/s/abc");
    }

    #[test]
    fn decode_checkout_errors_when_url_missing() {
        // Wallet-funded checkout has no checkout_url; the MoR command needs one.
        let json = r#"{"order_id":"ord_1","owned":["home-diy"]}"#;
        let err = decode_checkout(json).unwrap_err();
        assert!(matches!(err, BackendError::Decode(_)));
    }

    #[test]
    fn decode_order_extracts_status() {
        let json = r#"{"order_id":"ord_1","kind":"skill","target_id":"home-diy",
            "amount":500,"currency":"USD","payment_source":"mor",
            "status":"pending","created_at":"2026-07-12T00:00:00Z"}"#;
        let r = decode_order(json).unwrap();
        assert_eq!(r.order_id, "ord_1");
        assert_eq!(r.status, "pending");
    }

    #[test]
    fn decode_entitlements_maps_rows() {
        let json = r#"[{"skill_id":"home-diy","status":"owned"},
            {"skill_id":"garden-plants","status":"revoked"}]"#;
        let rows = decode_entitlements(json).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], EntitlementItem { skill_id: "home-diy".into(), status: "owned".into() });
        assert_eq!(rows[1].status, "revoked");
    }

    #[test]
    fn decode_license_takes_token_as_compact_jws() {
        let json = r#"{"license_id":"lic_1","token":"eyJhbGciOiJFUzI1NiJ9.e30.sig","kid":"k1"}"#;
        let r = decode_license(json).unwrap();
        assert_eq!(r.compact_jws, "eyJhbGciOiJFUzI1NiJ9.e30.sig");
    }

    #[test]
    fn decode_download_maps_all_fields() {
        let json = r#"{"url":"https://blob.example/x?sig=1",
            "expires_at":"2026-07-12T01:00:00Z","watermark":"wm-abc"}"#;
        let r = decode_download(json).unwrap();
        assert_eq!(r.url, "https://blob.example/x?sig=1");
        assert_eq!(r.expires_at, "2026-07-12T01:00:00Z");
        assert_eq!(r.watermark, "wm-abc");
    }

    #[test]
    fn decode_reports_error_on_garbage() {
        assert!(matches!(decode_catalog("not json"), Err(BackendError::Decode(_))));
        assert!(matches!(decode_order("{}"), Err(BackendError::Decode(_))));
    }

    // --- accounts / devices (P1-09.x) --------------------------------------

    #[test]
    fn auth_and_device_routes_are_built_correctly() {
        assert_eq!(auth_register_route(BASE), "http://api.example/v1/auth/register");
        assert_eq!(auth_login_route(BASE), "http://api.example/v1/auth/login");
        assert_eq!(auth_refresh_route(BASE), "http://api.example/v1/auth/refresh");
        assert_eq!(auth_logout_route(BASE), "http://api.example/v1/auth/logout");
        assert_eq!(device_register_route(BASE), "http://api.example/v1/devices/register");
    }

    #[test]
    fn credentials_and_device_bodies_are_snake_case() {
        let c = serde_json::to_value(CredentialsBody { email: "a@b.c", password: "hunter2!" }).unwrap();
        assert_eq!(c["email"], "a@b.c");
        assert_eq!(c["password"], "hunter2!");

        let d = serde_json::to_value(DeviceRegisterBody { name: "Chef PC", fingerprint: "fp1-x" }).unwrap();
        assert_eq!(d["name"], "Chef PC");
        assert_eq!(d["fingerprint"], "fp1-x");

        let r = serde_json::to_value(RefreshTokenBody { refresh_token: "rt-1" }).unwrap();
        assert_eq!(r["refresh_token"], "rt-1");
    }

    #[test]
    fn decode_auth_response_carries_tokens_and_email() {
        let json = r#"{
            "access_jwt": "eyJ.aaa.sig",
            "refresh_token": "rt-abc",
            "user": { "id": "usr_1", "email": "chef@example.com", "email_verified": true },
            "recovery_code": null
        }"#;
        let s = decode_auth_response(json).unwrap();
        assert_eq!(s.access_token, "eyJ.aaa.sig");
        assert_eq!(s.refresh_token, "rt-abc");
        assert_eq!(s.email.as_deref(), Some("chef@example.com"));
    }

    #[test]
    fn decode_auth_response_tolerates_a_device_only_account() {
        // Device-only registration: no user email echoed.
        let json = r#"{"access_jwt":"a.b.c","refresh_token":"rt","user":{"id":"usr_2"}}"#;
        let s = decode_auth_response(json).unwrap();
        assert_eq!(s.email, None);
    }

    #[test]
    fn decode_token_pair_has_no_email() {
        let json = r#"{"access_jwt":"a.b.c","refresh_token":"rt-2"}"#;
        let s = decode_token_pair(json).unwrap();
        assert_eq!(s.access_token, "a.b.c");
        assert_eq!(s.refresh_token, "rt-2");
        assert_eq!(s.email, None);
    }

    #[test]
    fn decode_device_extracts_id_and_status() {
        let json = r#"{"id":"dev_7","name":"Chef PC","status":"active",
            "last_seen_at":"2026-07-12T00:00:00Z","created_at":"2026-07-12T00:00:00Z"}"#;
        let d = decode_device(json).unwrap();
        assert_eq!(d.device_id, "dev_7");
        assert_eq!(d.status, "active");
    }

    // --- fetch_bytes (P1-03.2 download+install bridge) — local loopback only ---
    //
    // F04: `fetch_bytes` now guards `url` against the client's configured base
    // (`self.base`) before it does anything network-facing, so every test here
    // builds the client with `with_base(<the stub server's own origin>)` — the
    // guard would otherwise reject the loopback stub as a "different host" than
    // the `http://localhost:8080` default.

    /// The stub server's origin (`http://127.0.0.1:<port>`), derived from the URL
    /// [`spawn_stub_server`] returns, so tests can build a client that allows it.
    fn stub_origin(stub_url: &str) -> &str {
        stub_url.trim_end_matches("/pkg")
    }

    #[tokio::test]
    async fn fetch_bytes_returns_the_body_verbatim_on_200() {
        let payload = b"hpskill-bytes-fixture-\x00\x01\x02".to_vec();
        let url = spawn_stub_server("HTTP/1.1 200 OK", payload.clone());
        let client = BackendClient::with_base(stub_origin(&url));
        let got = client.fetch_bytes(&url).await.expect("stub fetch succeeds");
        assert_eq!(got, payload);
    }

    /// F04: a non-2xx from an *allowed* host must still map to `Status`, but the
    /// raw body must NOT be echoed into the error the webview sees (that was the
    /// response-body-oracle half of the F04 finding — a rejected/erroring fetch of
    /// an attacker-chosen URL should never let JS read back arbitrary response
    /// bytes through the error message).
    #[tokio::test]
    async fn fetch_bytes_maps_non_2xx_to_status_error_without_echoing_the_body() {
        let url = spawn_stub_server("HTTP/1.1 403 Forbidden", b"link expired".to_vec());
        let client = BackendClient::with_base(stub_origin(&url));
        let err = client.fetch_bytes(&url).await.unwrap_err();
        match err {
            BackendError::Status { status, body } => {
                assert_eq!(status, 403);
                assert!(body.is_empty(), "non-2xx body must not be echoed to the caller, got {body:?}");
            }
            other => panic!("expected Status error, got {other:?}"),
        }
    }

    /// F04: a disallowed URL (different host than the configured base) must be
    /// rejected by the guard BEFORE any network call — proven by pointing at a
    /// non-routable TEST-NET-style address and bounding the call with a short
    /// timeout. If the guard were bypassed, `self.http.get(...).send()` would
    /// either hang past the timeout (elapsed => the `.expect` panics) or, at
    /// best for an attacker, fail fast as `BackendError::Network` rather than
    /// `DisallowedUrl` — either way the `DisallowedUrl` assertion below would
    /// fail, so this is a real RED/GREEN gate on "guard runs first", not just on
    /// "some error occurred".
    #[tokio::test]
    async fn fetch_bytes_rejects_a_disallowed_url_without_a_network_call() {
        let client = BackendClient::with_base("http://localhost:8080");
        let fut = client.fetch_bytes("http://10.255.255.1:1/steal");
        let result = tokio::time::timeout(std::time::Duration::from_millis(300), fut).await;
        let err = result
            .expect("guard must reject synchronously, not leave a connect attempt in flight")
            .unwrap_err();
        assert!(matches!(err, BackendError::DisallowedUrl(_)), "expected DisallowedUrl, got {err:?}");
    }

    /// F04: same guard, `file://` this time — makes explicit that a non-http(s)
    /// scheme is refused even when no "host" comparison is in play.
    #[tokio::test]
    async fn fetch_bytes_rejects_a_non_http_scheme_without_a_network_call() {
        let client = BackendClient::with_base("http://localhost:8080");
        let err = client.fetch_bytes("file:///etc/passwd").await.unwrap_err();
        assert!(matches!(err, BackendError::DisallowedUrl(_)), "expected DisallowedUrl, got {err:?}");
    }

    /// F04 follow-up: `allowed_fetch_url` only ever checks the INITIAL url —
    /// once past the guard, the underlying `reqwest::Client` must not follow a
    /// `3xx` an ALLOWLISTED host answers with, or a redirect to an
    /// off-allowlist host would reopen the exact hole the guard closes. The
    /// `Location` here is a non-routable TEST-NET-style address (same
    /// technique as `fetch_bytes_rejects_a_disallowed_url_without_a_network_call`):
    /// if the client's redirect policy followed it, `.send()` would still be
    /// dialing well past this timeout, so a clean, fast `Status{302}` is real
    /// proof no redirect was followed — not just that "some" error came back.
    #[tokio::test]
    async fn fetch_bytes_does_not_follow_a_redirect_to_an_off_allowlist_host() {
        let url = spawn_redirect_stub_server(
            "HTTP/1.1 302 Found",
            "http://10.255.255.1:1/off-host-marker",
            b"redirecting...".to_vec(),
        );
        let client = BackendClient::with_base(stub_origin(&url));
        let fut = client.fetch_bytes(&url);
        let result = tokio::time::timeout(std::time::Duration::from_millis(300), fut)
            .await
            .expect("the client must not still be dialing the Location host — redirects are disabled");
        match result {
            Err(BackendError::Status { status, body }) => {
                assert_eq!(status, 302, "the origin's own 3xx must surface, not a followed response");
                assert!(body.is_empty(), "body must not be echoed (F04 response-body-oracle mitigation)");
            }
            other => panic!("expected Err(Status{{302, \"\"}}), got {other:?}"),
        }
    }
}
