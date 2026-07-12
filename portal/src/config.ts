// Portal configuration. Runtime correctness is out of scope for this task (verified by
// `tsc --noEmit` only), so these are sensible, editable defaults rather than a build-time
// injection system.

declare global {
  interface Window {
    /** Optional runtime override, e.g. set on window before app.js loads. */
    HYDROPARK_API_BASE?: string;
  }
}

/**
 * Origin of the backend REST API. Empty string == same origin (the portal is served from the
 * same host as the API, or a dev proxy forwards /v1/** to it). Override via
 * `window.HYDROPARK_API_BASE = "https://api.hydropark.io"` before the app boots.
 */
export const API_BASE: string = window.HYDROPARK_API_BASE ?? "";

/** localStorage keys. NB: tokens in localStorage are XSS-reachable — acceptable for this
 *  framework-light portal; a production build should prefer httpOnly cookies or in-memory only. */
export const STORAGE = {
  access: "hp.portal.access_jwt",
  refresh: "hp.portal.refresh_token",
  user: "hp.portal.user",
} as const;

/** Where "contact support" / refund requests are routed (no ticketing API exists — see support view). */
export const SUPPORT_EMAIL = "support@hydropark.io";

/** SPEC §13.7 — refunds are self-served within 14 days of purchase, then support-only. */
export const REFUND_WINDOW_DAYS = 14;
