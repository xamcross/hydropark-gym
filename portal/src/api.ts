// Typed endpoint layer over the generic apiClient. One function per backend route, returning the
// exact wire type. Routes/shapes verified against the Java controllers:
//   - AuthController        (/v1/auth/**)
//   - OrderController       (/v1/orders)
//   - DeviceController      (/v1/devices)
//   - AccountController     (/v1/account/**)
//   - EntitlementController (/v1/entitlements)

import { request } from "./apiClient";
import type {
  AccountExport,
  AuthResponse,
  CursorPage,
  DeletionJob,
  DeviceView,
  EntitlementView,
  OrderView,
  StepUpBeginResponse,
} from "./types";

function withQuery(base: string, params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      q.set(key, String(value));
    }
  }
  const qs = q.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
}

// ---- auth (/v1/auth) --------------------------------------------------------------------------

export const authApi = {
  register(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>("/v1/auth/register", {
      method: "POST",
      auth: false,
      body: { email, password },
    });
  },

  login(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>("/v1/auth/login", {
      method: "POST",
      auth: false,
      body: { email, password },
    });
  },

  logout(refreshToken: string): Promise<void> {
    return request<void>("/v1/auth/logout", {
      method: "POST",
      auth: false,
      body: { refresh_token: refreshToken },
    });
  },

  verifyEmail(verifyToken: string): Promise<void> {
    return request<void>("/v1/auth/verify-email", {
      method: "POST",
      auth: false,
      body: { verify_token: verifyToken },
    });
  },

  resendVerification(): Promise<void> {
    return request<void>("/v1/auth/verify-email/resend", { method: "POST" });
  },

  requestPasswordReset(email: string): Promise<void> {
    return request<void>("/v1/auth/password/reset-request", {
      method: "POST",
      auth: false,
      body: { email },
    });
  },

  resetPassword(resetToken: string, newPassword: string): Promise<void> {
    return request<void>("/v1/auth/password/reset", {
      method: "POST",
      auth: false,
      body: { reset_token: resetToken, new_password: newPassword },
    });
  },

  /** Begins a step-up challenge (e.g. before deauthorizing the last device). */
  stepUpBegin(action: string): Promise<StepUpBeginResponse> {
    return request<StepUpBeginResponse>("/v1/auth/step-up/begin", {
      method: "POST",
      body: { action },
    });
  },
};

// ---- orders (/v1/orders) ----------------------------------------------------------------------

export const ordersApi = {
  list(cursor?: string | null, limit?: number): Promise<CursorPage<OrderView>> {
    return request<CursorPage<OrderView>>(withQuery("/v1/orders", { cursor, limit }));
  },

  get(orderId: string): Promise<OrderView> {
    return request<OrderView>(`/v1/orders/${encodeURIComponent(orderId)}`);
  },
};

// ---- devices (/v1/devices) --------------------------------------------------------------------

export const devicesApi = {
  list(cursor?: string | null, limit?: number): Promise<CursorPage<DeviceView>> {
    return request<CursorPage<DeviceView>>(withQuery("/v1/devices", { limit, cursor }));
  },

  rename(deviceId: string, name: string): Promise<DeviceView> {
    return request<DeviceView>(`/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: "PATCH",
      body: { name },
    });
  },

  /**
   * Deauthorize a device. Deauthorizing the LAST active device is step-up gated server-side
   * (403 step_up_required unless a valid X-Step-Up-Token is supplied).
   */
  deauthorize(deviceId: string, stepUpToken?: string): Promise<DeviceView> {
    const headers: Record<string, string> = {};
    if (stepUpToken !== undefined && stepUpToken.length > 0) {
      headers["X-Step-Up-Token"] = stepUpToken;
    }
    return request<DeviceView>(`/v1/devices/${encodeURIComponent(deviceId)}/deauthorize`, {
      method: "POST",
      headers,
    });
  },
};

// ---- account lifecycle (/v1/account) ----------------------------------------------------------

export const accountApi = {
  exportData(): Promise<AccountExport> {
    return request<AccountExport>("/v1/account/export");
  },

  requestDeletion(): Promise<DeletionJob> {
    return request<DeletionJob>("/v1/account/delete", { method: "POST" });
  },

  deletionStatus(jobId: string): Promise<DeletionJob> {
    return request<DeletionJob>(`/v1/account/delete/${encodeURIComponent(jobId)}`);
  },
};

// ---- entitlements (/v1/entitlements) ----------------------------------------------------------

export const entitlementsApi = {
  list(): Promise<EntitlementView[]> {
    return request<EntitlementView[]>("/v1/entitlements");
  },
};
