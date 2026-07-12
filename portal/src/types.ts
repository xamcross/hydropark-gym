// Wire types for the Hydropark backend REST API (/v1/**).
//
// The backend serialises with a GLOBAL snake_case naming strategy
// (backend/src/main/resources/application.yml -> spring.jackson.property-naming-strategy:
// SNAKE_CASE), so every field below is snake_case to match the JSON exactly. The @JsonProperty
// annotations sprinkled through the Java DTOs are belt-and-suspenders on top of that global rule.
//
// Timestamps are Java `Instant`s -> ISO-8601 strings on the wire (e.g. "2026-07-12T10:15:30Z").
// Money `amount` is a Java `long` in the currency's MINOR unit (cents) -> a JSON number.

/** io.hydropark.auth.web.AuthDtos.UserView */
export interface UserView {
  id: string;
  /** Absent for a device-only account (email is optional). */
  email?: string | null;
  email_verified: boolean;
}

/** io.hydropark.auth.web.AuthDtos.AuthResponse (register / login / oauth). */
export interface AuthResponse {
  access_jwt: string;
  refresh_token: string;
  user: UserView;
  /** Shown once on registration; absent thereafter. */
  recovery_code?: string | null;
}

/** io.hydropark.auth.web.AuthDtos.TokenPair (POST /v1/auth/refresh). */
export interface TokenPair {
  access_jwt: string;
  refresh_token: string;
}

/** io.hydropark.auth.web.AuthDtos.StepUpBeginResponse (POST /v1/auth/step-up/begin). */
export interface StepUpBeginResponse {
  challenge_id: string;
  factor: string;
  expires_at: string | null;
}

/** io.hydropark.common.CursorPage<T> — every list endpoint. */
export interface CursorPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the last page has been reached. */
  next_cursor: string | null;
}

/**
 * io.hydropark.commerce.OrderView (GET /v1/orders, GET /v1/orders/{id}).
 * kind: "skill" | "bundle" | "wallet_topup"; payment_source: "mor" | "wallet";
 * status: "pending" | "paid" | "failed" | "refunded" | "charged_back".
 */
export interface OrderView {
  order_id: string;
  kind: string;
  target_id: string;
  /** Minor units (cents). */
  amount: number;
  currency: string;
  payment_source: string;
  status: string;
  created_at: string;
}

/**
 * io.hydropark.devices.dto.DeviceView (GET /v1/devices, PATCH /v1/devices/{id}, deauthorize).
 * `fingerprint` is deliberately omitted server-side (never leaves the backend).
 */
export interface DeviceView {
  id: string;
  /** Optional at registration, so may be null. */
  name: string | null;
  status: string;
  last_seen_at: string | null;
  created_at: string | null;
}

/**
 * io.hydropark.licensing.EntitlementView (GET /v1/entitlements).
 * status: "owned" when >=1 active grant; otherwise the most-recent terminal status
 * ("refunded" | "charged_back" | "revoked").
 */
export interface EntitlementView {
  skill_id: string;
  status: string;
}

/** io.hydropark.auth.service.AccountService.DeletionJob (POST/GET /v1/account/delete). */
export interface DeletionJob {
  job_id: string;
  /** "pending" | "completed". */
  status: string;
  requested_at: string | null;
  completed_at: string | null;
}

/** io.hydropark.auth.service.AccountService.AccountView (inside the export). */
export interface AccountView {
  id: string;
  email: string | null;
  email_verified: boolean;
  status: string;
  created_at: string | null;
}

/** io.hydropark.auth.service.AccountService.OAuthView (inside the export). */
export interface OAuthView {
  provider: string;
  linked_at: string | null;
}

/** io.hydropark.auth.service.AccountService.AccountExport (GET /v1/account/export). */
export interface AccountExport {
  account: AccountView;
  oauth_identities: OAuthView[];
  note: string;
}

/** io.hydropark.common.ApiError.Body — the error envelope (Appendix A). */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** io.hydropark.common.ApiError — { "error": { code, message, details } }. */
export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}
