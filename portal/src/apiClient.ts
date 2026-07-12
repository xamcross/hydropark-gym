// Typed fetch wrapper for the Hydropark REST API.
//
//  - attaches `Authorization: Bearer <access_jwt>` on authenticated calls
//  - on a 401, transparently refreshes via POST /v1/auth/refresh (single-flight) and retries once
//  - decodes the Appendix-A error envelope ({ error: { code, message, details } }) into ApiError
//
// No `any` escapes: `Response.json()` is laundered through `unknown` before every cast.

import { API_BASE } from "./config";
import * as session from "./session";
import { SESSION_EXPIRED } from "./session";
import type { ApiErrorBody, ApiErrorEnvelope, TokenPair } from "./types";

/** A non-2xx response, carrying the backend's wire error code so callers can branch on it. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message.length > 0 ? body.message : `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? {};
  }
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
  method?: HttpMethod;
  /** Serialised as JSON (unless it is already a FormData). */
  body?: unknown;
  /** Attach the bearer token + enable refresh-on-401. Default true. */
  auth?: boolean;
  /** Extra request headers (e.g. X-Step-Up-Token, Idempotency-Key). */
  headers?: Record<string, string>;
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const err = (value as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return typeof code === "string" && typeof message === "string";
}

async function readErrorBody(res: Response): Promise<ApiErrorBody> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // network / body already consumed — fall through to a synthetic body
  }
  if (text.length > 0) {
    try {
      const raw: unknown = JSON.parse(text);
      if (isErrorEnvelope(raw)) {
        return raw.error;
      }
    } catch {
      // not JSON — fall through
    }
  }
  const statusText = res.statusText.length > 0 ? ` ${res.statusText}` : "";
  return { code: "unknown_error", message: `HTTP ${res.status}${statusText}` };
}

// ---- single-flight token refresh --------------------------------------------------------------

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const refreshToken = session.getRefreshToken();
  if (refreshToken === null) {
    return false;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    return false;
  }
  if (!res.ok) {
    return false;
  }
  const text = await res.text();
  if (text.length === 0) {
    return false;
  }
  const pair = JSON.parse(text) as TokenPair;
  session.setTokens(pair.access_jwt, pair.refresh_token);
  return true;
}

/** Coalesce concurrent 401s onto one refresh call. */
function ensureRefresh(): Promise<boolean> {
  if (refreshInFlight === null) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// ---- core request -----------------------------------------------------------------------------

async function send<T>(path: string, opts: RequestOptions, retrying: boolean): Promise<T> {
  const useAuth = opts.auth !== false;
  const isForm = opts.body instanceof FormData;

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !isForm) {
    headers["Content-Type"] = "application/json";
  }
  if (useAuth) {
    const token = session.getAccessToken();
    if (token !== null) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body:
      opts.body === undefined
        ? undefined
        : isForm
          ? (opts.body as FormData)
          : JSON.stringify(opts.body),
  });

  if (res.status === 401 && useAuth && !retrying && session.getRefreshToken() !== null) {
    const refreshed = await ensureRefresh();
    if (refreshed) {
      return send<T>(path, opts, true);
    }
    session.signOutLocal();
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED));
    throw new ApiError(401, {
      code: "unauthorized",
      message: "Your session has expired. Please sign in again.",
    });
  }

  if (!res.ok) {
    throw new ApiError(res.status, await readErrorBody(res));
  }

  // 204 No Content (verify-email, logout, password reset) and empty bodies -> void.
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  const text = await res.text();
  if (text.length === 0) {
    return undefined as unknown as T;
  }
  return JSON.parse(text) as T;
}

export function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return send<T>(path, opts, false);
}
