//! Shared guard for absolute URLs the Rust core is asked to fetch on the
//! webview's behalf (F04, Task 9 punch-list review).
//!
//! `BackendClient::fetch_bytes` (the signed `.hpskill` blob URL bridge —
//! `backend_client.rs`) and `DownloadManager`'s model-GGUF fetch
//! (`downloader.rs`) both take an ABSOLUTE URL that arrives over IPC from the
//! webview — ultimately whatever JSON the backend's `download_url` /
//! `model_download_start` caller handed back to it. Tauri commands in this
//! app are not ACL-gated (see `capabilities/default.json`), so any JS running
//! in the webview (XSS, a compromised npm dep) could otherwise invoke these
//! commands directly with an arbitrary `http(s)://` URL — including
//! loopback/link-local/internal addresses — turning the Rust core into a
//! generic fetch proxy and defeating the `connect-src 'self'` CSP the
//! Rust-side fetch was meant to enforce.
//!
//! ## Why the backend origin is the right (and only) allowlist entry
//! Both the skill-blob URL (`GET /v1/download/skills/{id}/{version}`) and the
//! model-GGUF URL (`GET /v1/download/model/{modelId}`, BACKEND-DESIGN §4.5 /
//! P1-19.3) are minted by the SAME backend call —
//! `BlobStore.signedUrl(objectKey, scope, ttl)` — in
//! `io.hydropark.download.DownloadService.issueSkillDownload` /
//! `.issueModelDownload`, and served back from `BlobStoreProperties.baseUrl`,
//! which defaults to `http://localhost:8080/blobs` (i.e. the API base host +
//! `/blobs`, not a separate CDN host — see `LocalFsBlobStore`). No
//! `HYDROPARK_*` env var configures a distinct CDN/model host anywhere in
//! this client today (checked: no `HYDROPARK_BLOB*`/`HYDROPARK_CDN*`/
//! `HYDROPARK_MODEL_CDN*` etc. exist), so the configured backend base
//! (`HYDROPARK_API_BASE`, see `backend_client::base_url`) is the only host
//! this client can legitimately fetch an absolute URL from. A future
//! production deployment that serves blobs from a distinct R2/CDN host (the
//! backend also has an `R2BlobStore`) will need its own wired-in client
//! config before that host can be added here — guessing one now would be
//! exactly the kind of allowlist hole this fix exists to close.
//!
//! ## Design
//! Pure and synchronous — no I/O, no env access — so both call sites run it
//! before making any network call, and it is directly unit-testable without a
//! mock server. The env read (`HYDROPARK_API_BASE`) stays where it already
//! lived (`backend_client::base_url`); callers pass the resolved base in.

use reqwest::Url;

/// Why a webview-supplied absolute URL was refused before any network call
/// was made.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchGuardError {
    /// Not a parseable absolute URL at all (includes garbage input and a
    /// scheme-relative/relative string with no scheme).
    #[error("could not parse as an absolute URL")]
    InvalidUrl,
    /// Parsed fine, but the scheme is not `http`/`https` — e.g. `file://`,
    /// `ftp://`, `gopher://`, `data:`.
    #[error("scheme `{0}` is not allowed (only http/https)")]
    UnsupportedScheme(String),
    /// Parsed with an allowed scheme, but the `(scheme, host, port)` origin
    /// does not match the configured backend origin.
    #[error("host is not the configured backend origin")]
    HostNotAllowed,
}

/// The `(scheme, host, port)` triple that identifies an origin for this
/// guard. A bare host-string match is not enough — e.g. a webview-supplied
/// `https://<base-host>:1/...` must not be treated as the real backend — so
/// the port participates too. Returns `None` when the URL carries no host
/// (which, combined with the scheme check in [`allowed_fetch_url`], only
/// happens for malformed input).
fn origin(url: &Url) -> Option<(String, String, u16)> {
    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default()?;
    Some((url.scheme().to_ascii_lowercase(), host, port))
}

/// Parse `raw` and check it is an `http`/`https` URL on the EXACT same origin
/// as `base` (the configured backend base — see the module doc for why that
/// is the only legitimate allowlist entry). Returns the parsed [`Url`] so the
/// caller does not have to re-parse it for the actual request.
///
/// `base` itself is expected to already be well-formed (it is
/// `backend_client::base_url()`'s output — env-configured or the
/// `DEFAULT_API_BASE` dev default); if it somehow fails to parse this
/// fails closed (`InvalidUrl`) rather than allowing anything through.
pub fn allowed_fetch_url(raw: &str, base: &str) -> Result<Url, FetchGuardError> {
    let url = Url::parse(raw).map_err(|_| FetchGuardError::InvalidUrl)?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(FetchGuardError::UnsupportedScheme(scheme.to_string()));
    }
    let base_url = Url::parse(base).map_err(|_| FetchGuardError::InvalidUrl)?;
    match (origin(&base_url), origin(&url)) {
        (Some(allowed), Some(actual)) if allowed == actual => Ok(url),
        _ => Err(FetchGuardError::HostNotAllowed),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const BASE_DEV: &str = "http://localhost:8080";
    const BASE_PROD: &str = "https://api.hydropark.example";

    #[test]
    fn allows_the_exact_configured_origin_http_dev() {
        assert!(allowed_fetch_url("http://localhost:8080/blobs/skills/x?sig=1", BASE_DEV).is_ok());
    }

    #[test]
    fn allows_the_exact_configured_origin_https_prod() {
        assert!(
            allowed_fetch_url("https://api.hydropark.example/blobs/models/qwen.gguf", BASE_PROD)
                .is_ok()
        );
    }

    #[test]
    fn allows_the_exact_signed_blob_path_on_the_base_host() {
        // Mirrors a real `DownloadService.issueSkillDownload` URL shape (scope+exp+sig query).
        let url = "http://localhost:8080/blobs/skills/home-diy/1.4.2.hpskill?scope=usr_1&exp=1893456000&sig=abc123";
        let got = allowed_fetch_url(url, BASE_DEV).expect("signed blob path on the base host is allowed");
        assert_eq!(got.as_str(), url);
    }

    #[test]
    fn rejects_a_different_host() {
        assert_eq!(
            allowed_fetch_url("http://evil.example/steal", BASE_DEV),
            Err(FetchGuardError::HostNotAllowed)
        );
    }

    #[test]
    fn rejects_loopback_by_ip_when_the_base_host_is_the_dns_name() {
        // `127.0.0.1` and `localhost` are different host strings — no bypass via IP literal.
        assert_eq!(
            allowed_fetch_url("http://127.0.0.1:8080/blobs/x", BASE_DEV),
            Err(FetchGuardError::HostNotAllowed)
        );
    }

    #[test]
    fn rejects_a_mismatched_port_on_the_same_host() {
        assert_eq!(
            allowed_fetch_url("http://localhost:9999/blobs/x", BASE_DEV),
            Err(FetchGuardError::HostNotAllowed)
        );
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert_eq!(
            allowed_fetch_url("file:///etc/passwd", BASE_DEV),
            Err(FetchGuardError::UnsupportedScheme("file".to_string()))
        );
        assert_eq!(
            allowed_fetch_url("ftp://localhost:8080/x", BASE_DEV),
            Err(FetchGuardError::UnsupportedScheme("ftp".to_string()))
        );
        assert_eq!(
            allowed_fetch_url("gopher://localhost:8080/x", BASE_DEV),
            Err(FetchGuardError::UnsupportedScheme("gopher".to_string()))
        );
    }

    #[test]
    fn rejects_plain_http_against_an_https_production_base() {
        // A real prod backend is never plaintext — matching host but wrong scheme still refuses.
        assert_eq!(
            allowed_fetch_url("http://api.hydropark.example/blobs/x", BASE_PROD),
            Err(FetchGuardError::HostNotAllowed)
        );
    }

    #[test]
    fn rejects_an_unparseable_url() {
        assert_eq!(allowed_fetch_url("not a url", BASE_DEV), Err(FetchGuardError::InvalidUrl));
        assert_eq!(allowed_fetch_url("", BASE_DEV), Err(FetchGuardError::InvalidUrl));
    }

    #[test]
    fn userinfo_trick_does_not_bypass_the_host_check() {
        // `localhost:8080` here parses as USERINFO (user:password), not host — the real
        // host is `evil.example`, which must still be refused.
        assert_eq!(
            allowed_fetch_url("http://localhost:8080@evil.example/steal", BASE_DEV),
            Err(FetchGuardError::HostNotAllowed)
        );
    }
}
