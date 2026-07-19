#![allow(dead_code)] // Wired into main.rs's deep-link handler; the parser is also unit-tested standalone.

//! Purchase-callback deep-link parsing (P1-01.2).
//!
//! After the hosted checkout completes, the payment page redirects the OS to a
//! `hydropark://…` URL, which the OS routes back into the running app via
//! `tauri-plugin-deep-link`. `main.rs` registers the [`SCHEME`] and, on each
//! opened URL, calls [`parse_purchase_callback`]; when it recognises a purchase
//! callback it emits the webview event `purchase://callback` carrying the
//! `{ orderId }` that the Angular purchase flow is listening for (so the flow can
//! stop polling the hosted page and resume against `order_get`).
//!
//! This module is the pure, unit-testable parser half; the plugin wiring and the
//! event emit (which need a running Tauri app) live in `main.rs`.

/// The custom URL scheme the OS routes back to the app (registered in
/// `tauri.conf.json` under `plugins.deep-link.desktop.schemes`).
pub const SCHEME: &str = "hydropark";

/// Parse a `hydropark://…` deep link, returning the order id **iff** it is a
/// purchase callback. Tolerant of:
///   - host-vs-path placement (`hydropark://purchase/callback?…` and
///     `hydropark://purchase-callback?…` are both accepted),
///   - a trailing slash and case,
///   - the order-id param spelled `orderId`, `order_id`, or `order`.
///
/// Returns `None` for any non-purchase scheme/path or a callback with no order id,
/// so the caller can silently ignore unrelated deep links.
pub fn parse_purchase_callback(url: &str) -> Option<String> {
    let rest = url.strip_prefix(&format!("{SCHEME}://"))?;

    // Drop any fragment, then split path from query.
    let rest = rest.split('#').next().unwrap_or(rest);
    let (path, query) = match rest.split_once('?') {
        Some((p, q)) => (p, q),
        None => (rest, ""),
    };

    // Normalise the path (host + path read the same for a custom scheme).
    let path_norm = path.trim_end_matches('/').to_ascii_lowercase();
    let is_purchase_callback = matches!(path_norm.as_str(), "purchase/callback" | "purchase-callback")
        || path_norm.ends_with("/purchase/callback")
        || path_norm.ends_with("/purchase-callback");
    if !is_purchase_callback {
        return None;
    }

    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            if matches!(key, "orderId" | "order_id" | "order") {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_canonical_callback() {
        assert_eq!(
            parse_purchase_callback("hydropark://purchase/callback?orderId=ord_123"),
            Some("ord_123".to_string())
        );
    }

    #[test]
    fn tolerates_host_form_param_spellings_case_and_trailing_slash() {
        // host form (`purchase-callback`), snake_case param.
        assert_eq!(
            parse_purchase_callback("hydropark://purchase-callback?order_id=ord_9"),
            Some("ord_9".to_string())
        );
        // trailing slash + extra params + `order` spelling.
        assert_eq!(
            parse_purchase_callback("hydropark://purchase/callback/?status=paid&order=ord_x"),
            Some("ord_x".to_string())
        );
        // uppercase in the path is normalised.
        assert_eq!(
            parse_purchase_callback("hydropark://Purchase/Callback?orderId=ord_Q"),
            Some("ord_Q".to_string())
        );
        // a fragment after the query is ignored.
        assert_eq!(
            parse_purchase_callback("hydropark://purchase-callback?orderId=ord_f#done"),
            Some("ord_f".to_string())
        );
    }

    #[test]
    fn rejects_non_purchase_or_orderless_links() {
        // wrong scheme.
        assert_eq!(parse_purchase_callback("https://purchase/callback?orderId=x"), None);
        // right scheme, unrelated path.
        assert_eq!(parse_purchase_callback("hydropark://open/skill/home-diy"), None);
        // purchase callback but no order id.
        assert_eq!(parse_purchase_callback("hydropark://purchase/callback?status=cancelled"), None);
        // purchase callback, empty order id.
        assert_eq!(parse_purchase_callback("hydropark://purchase-callback?orderId="), None);
    }
}
