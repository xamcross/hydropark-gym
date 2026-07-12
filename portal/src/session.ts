// Client-side session state: the bearer access token, the refresh token, and a cached UserView.
// Persisted in localStorage so a reload keeps the user signed in.

import { STORAGE } from "./config";
import type { AuthResponse, UserView } from "./types";

/** Fired (as a window CustomEvent) whenever the signed-in state changes, so the nav can re-render. */
export const SESSION_CHANGED = "hp:session";

/** Fired when a refresh attempt failed and the user was forced out. */
export const SESSION_EXPIRED = "hp:session-expired";

function emitChange(): void {
  window.dispatchEvent(new CustomEvent(SESSION_CHANGED));
}

export function getAccessToken(): string | null {
  return localStorage.getItem(STORAGE.access);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(STORAGE.refresh);
}

export function isAuthenticated(): boolean {
  return getAccessToken() !== null;
}

export function setTokens(accessJwt: string, refreshToken: string): void {
  localStorage.setItem(STORAGE.access, accessJwt);
  localStorage.setItem(STORAGE.refresh, refreshToken);
}

export function getUser(): UserView | null {
  const raw = localStorage.getItem(STORAGE.user);
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as UserView;
  } catch {
    return null;
  }
}

export function setUser(user: UserView | null): void {
  if (user === null) {
    localStorage.removeItem(STORAGE.user);
  } else {
    localStorage.setItem(STORAGE.user, JSON.stringify(user));
  }
}

/** Store tokens + user from a login/register response and notify listeners. */
export function applyAuth(resp: AuthResponse): void {
  setTokens(resp.access_jwt, resp.refresh_token);
  setUser(resp.user);
  emitChange();
}

/** Drop all local session state and notify listeners. */
export function signOutLocal(): void {
  localStorage.removeItem(STORAGE.access);
  localStorage.removeItem(STORAGE.refresh);
  localStorage.removeItem(STORAGE.user);
  emitChange();
}
