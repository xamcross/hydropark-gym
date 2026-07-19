// Bootstrap: wires the nav, the hash router, auth guards, and session events into the static shell
// defined in index.html. Framework-free; every view is a plain render(outlet) function.

import { authApi } from "./api";
import { el, replaceChildren, requireEl } from "./dom";
import { navigate, parseHash } from "./router";
import type { RouteDef } from "./router";
import * as session from "./session";
import { SESSION_CHANGED, SESSION_EXPIRED } from "./session";
import { announce, banner, button, errorMessage, setFlash } from "./ui";
import { renderDevices } from "./views/devices";
import { renderEntitlements } from "./views/entitlements";
import { renderLogin } from "./views/login";
import { renderPrivacy } from "./views/privacy";
import { renderPurchases } from "./views/purchases";
import { renderRefund } from "./views/refund";
import { renderSupport } from "./views/support";

const routes: ReadonlyArray<RouteDef> = [
  { path: "/login", label: "Sign in", render: renderLogin, requiresAuth: false, showInNav: false },
  { path: "/purchases", label: "Purchases", render: renderPurchases, requiresAuth: true, showInNav: true },
  { path: "/devices", label: "Devices", render: renderDevices, requiresAuth: true, showInNav: true },
  { path: "/entitlements", label: "Entitlements", render: renderEntitlements, requiresAuth: true, showInNav: true },
  { path: "/refund", label: "Refunds", render: renderRefund, requiresAuth: true, showInNav: true },
  { path: "/privacy", label: "Privacy", render: renderPrivacy, requiresAuth: true, showInNav: true },
  { path: "/support", label: "Support", render: renderSupport, requiresAuth: false, showInNav: true },
];

function defaultPath(): string {
  return session.isAuthenticated() ? "/purchases" : "/login";
}

function findRoute(path: string): RouteDef | undefined {
  return routes.find((r) => r.path === path);
}

// ---- nav + session chrome ---------------------------------------------------------------------

function renderNav(activePath: string): void {
  const list = requireEl("nav-list");
  replaceChildren(list);

  const authed = session.isAuthenticated();
  for (const route of routes) {
    if (!route.showInNav) {
      continue;
    }
    if (route.requiresAuth && !authed) {
      continue;
    }
    const link = el("a", {
      class: route.path === activePath ? "nav-link nav-link-active" : "nav-link",
      text: route.label,
      attrs: { href: `#${route.path}` },
    });
    if (route.path === activePath) {
      link.setAttribute("aria-current", "page");
    }
    list.append(el("li", { class: "nav-item" }, [link]));
  }

  renderSessionArea();
}

function renderSessionArea(): void {
  const area = requireEl("session-area");
  const user = session.getUser();
  if (session.isAuthenticated()) {
    const identity = user?.email ?? "Signed in";
    replaceChildren(
      area,
      el("span", { class: "session-user", text: identity, attrs: { title: user?.id ?? "" } }),
      button("Sign out", () => signOut(), "ghost"),
    );
  } else {
    replaceChildren(
      area,
      el("a", { class: "btn btn-primary", text: "Sign in", attrs: { href: "#/login", role: "button" } }),
    );
  }
}

function signOut(): void {
  const refreshToken = session.getRefreshToken();
  const done = (): void => {
    setFlash("You have been signed out.");
    session.signOutLocal();
    navigate("/login");
  };
  if (refreshToken !== null) {
    authApi.logout(refreshToken).then(done).catch(done);
  } else {
    done();
  }
}

// A persistent prompt to verify an unverified email (SPEC §12 email-optional funnel).
function renderVerifyBanner(): void {
  const host = requireEl("verify-banner");
  const user = session.getUser();
  if (!session.isAuthenticated() || user === null || user.email_verified || user.email == null) {
    replaceChildren(host);
    return;
  }
  const resend = button(
    "Resend verification email",
    (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      authApi
        .resendVerification()
        .then(() => {
          btn.textContent = "Verification email sent";
        })
        .catch((err: unknown) => {
          btn.disabled = false;
          announce(errorMessage(err));
        });
    },
    "secondary",
  );
  const bar = banner("warning", `Your email (${user.email}) isn't verified yet. `);
  bar.append(resend);
  replaceChildren(host, bar);
}

// ---- routing ----------------------------------------------------------------------------------

function route(): void {
  const { path } = parseHash();
  const outlet = requireEl("outlet");

  let target = findRoute(path);
  if (target === undefined) {
    navigate(defaultPath());
    return;
  }
  if (target.requiresAuth && !session.isAuthenticated()) {
    setFlash("Please sign in to continue.");
    navigate("/login");
    return;
  }
  // A signed-in user hitting /login is bounced to their account.
  if (target.path === "/login" && session.isAuthenticated()) {
    navigate("/purchases");
    return;
  }

  closeMobileNav();
  renderNav(target.path);
  renderVerifyBanner();
  target.render(outlet);
  outlet.focus();
}

function closeMobileNav(): void {
  const nav = document.getElementById("primary-nav");
  const toggle = document.getElementById("nav-toggle");
  if (nav !== null) {
    nav.classList.remove("open");
  }
  if (toggle !== null) {
    toggle.setAttribute("aria-expanded", "false");
  }
}

function wireMobileNav(): void {
  const toggle = document.getElementById("nav-toggle");
  const nav = document.getElementById("primary-nav");
  if (toggle === null || nav === null) {
    return;
  }
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

function boot(): void {
  wireMobileNav();

  window.addEventListener("hashchange", route);

  window.addEventListener(SESSION_CHANGED, () => {
    renderNav(parseHash().path);
    renderVerifyBanner();
  });

  window.addEventListener(SESSION_EXPIRED, () => {
    setFlash("Your session expired. Please sign in again.");
    navigate("/login");
  });

  if (location.hash === "" || location.hash === "#") {
    navigate(defaultPath());
  } else {
    route();
  }
}

boot();
