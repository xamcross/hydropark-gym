// P1-27 auth: sign in, create account, request a password reset, complete a password reset
// (?reset_token=), and verify an email (?verify_token=). Also offers "resend verification" when a
// signed-in user's email is unverified.

import { authApi } from "../api";
import { el, replaceChildren } from "../dom";
import { navigate, parseHash } from "../router";
import * as session from "../session";
import {
  announce,
  banner,
  button,
  card,
  consumeFlash,
  errorMessage,
  field,
  pageHead,
} from "../ui";
import type { BannerKind } from "../ui";

type Mode = "signin" | "register" | "reset-request";

export function renderLogin(outlet: HTMLElement): void {
  const { params } = parseHash();
  const resetToken = params.get("reset_token");
  const verifyToken = params.get("verify_token");

  // Deep-link flows first: an email link lands here with a token in the query.
  if (resetToken !== null) {
    renderResetForm(outlet, resetToken);
    return;
  }
  if (verifyToken !== null) {
    renderVerifyFlow(outlet, verifyToken);
    return;
  }

  const notice = el("div");
  const flash = consumeFlash();
  if (flash !== null) {
    notice.append(banner("info", flash));
  }

  const body = el("div", { class: "auth-body" });
  const tabs = el("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Authentication" } });

  const setMode = (mode: Mode): void => {
    for (const child of Array.from(tabs.children)) {
      const isActive = child.getAttribute("data-mode") === mode;
      child.classList.toggle("tab-active", isActive);
      child.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    if (mode === "signin") {
      renderSignIn(body);
    } else if (mode === "register") {
      renderRegister(body);
    } else {
      renderResetRequest(body);
    }
  };

  const tabDefs: ReadonlyArray<{ mode: Mode; label: string }> = [
    { mode: "signin", label: "Sign in" },
    { mode: "register", label: "Create account" },
    { mode: "reset-request", label: "Reset password" },
  ];
  for (const def of tabDefs) {
    tabs.append(
      el("button", {
        class: "tab",
        text: def.label,
        attrs: { type: "button", role: "tab", "data-mode": def.mode },
        on: { click: () => setMode(def.mode) },
      }),
    );
  }

  replaceChildren(
    outlet,
    pageHead("Your Hydropark account", "Manage purchases, devices, and privacy."),
    notice,
    card([tabs, body]),
  );
  setMode("signin");
  announce("Sign in page");
}

// ---- helpers ----------------------------------------------------------------------------------

function feedback(): { node: HTMLDivElement; show: (kind: BannerKind, message: string) => void } {
  const node = el("div", { class: "form-feedback" });
  const show = (kind: BannerKind, message: string): void => {
    replaceChildren(node, banner(kind, message));
    announce(message);
  };
  return { node, show };
}

function submitButton(label: string): HTMLButtonElement {
  return el("button", { class: "btn btn-primary", text: label, attrs: { type: "submit" } });
}

// ---- sign in ----------------------------------------------------------------------------------

function renderSignIn(container: HTMLElement): void {
  const email = field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email" });
  const password = field({
    label: "Password",
    name: "password",
    type: "password",
    required: true,
    autocomplete: "current-password",
  });
  const fb = feedback();
  const submit = submitButton("Sign in");

  const form = el(
    "form",
    {
      class: "form",
      attrs: { novalidate: "" },
      on: {
        submit: (ev) => {
          ev.preventDefault();
          submit.disabled = true;
          fb.show("info", "Signing in…");
          authApi
            .login(email.input.value.trim(), password.input.value)
            .then((resp) => {
              session.applyAuth(resp);
              navigate("/purchases");
            })
            .catch((err: unknown) => {
              fb.show("error", errorMessage(err));
            })
            .finally(() => {
              submit.disabled = false;
            });
        },
      },
    },
    [email.wrapper, password.wrapper, fb.node, el("div", { class: "form-actions" }, [submit])],
  );
  replaceChildren(container, form);
}

// ---- register ---------------------------------------------------------------------------------

function renderRegister(container: HTMLElement): void {
  const email = field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email" });
  const password = field({
    label: "Password",
    name: "password",
    type: "password",
    required: true,
    autocomplete: "new-password",
    help: "At least 8 characters.",
  });
  const fb = feedback();
  const submit = submitButton("Create account");

  const form = el(
    "form",
    {
      class: "form",
      attrs: { novalidate: "" },
      on: {
        submit: (ev) => {
          ev.preventDefault();
          if (password.input.value.length < 8) {
            fb.show("error", "Password must be at least 8 characters.");
            return;
          }
          submit.disabled = true;
          fb.show("info", "Creating your account…");
          authApi
            .register(email.input.value.trim(), password.input.value)
            .then((resp) => {
              session.applyAuth(resp);
              const recovery = resp.recovery_code;
              if (recovery !== null && recovery !== undefined && recovery.length > 0) {
                replaceChildren(
                  container,
                  banner("success", "Account created. Save your recovery code — it is shown only once."),
                  el("div", { class: "recovery" }, [
                    el("span", { class: "label", text: "Recovery code" }),
                    el("code", { class: "recovery-code", text: recovery }),
                  ]),
                  button("Continue to my account", () => navigate("/purchases"), "primary"),
                );
                announce("Account created. Recovery code shown.");
              } else {
                navigate("/purchases");
              }
            })
            .catch((err: unknown) => {
              fb.show("error", errorMessage(err));
              submit.disabled = false;
            });
        },
      },
    },
    [email.wrapper, password.wrapper, fb.node, el("div", { class: "form-actions" }, [submit])],
  );
  replaceChildren(container, form);
}

// ---- request password reset -------------------------------------------------------------------

function renderResetRequest(container: HTMLElement): void {
  const email = field({ label: "Email", name: "email", type: "email", required: true, autocomplete: "email" });
  const fb = feedback();
  const submit = submitButton("Email me a reset link");

  const form = el(
    "form",
    {
      class: "form",
      attrs: { novalidate: "" },
      on: {
        submit: (ev) => {
          ev.preventDefault();
          submit.disabled = true;
          authApi
            .requestPasswordReset(email.input.value.trim())
            // Always succeeds (no user enumeration): show the same confirmation regardless.
            .then(() => {
              fb.show(
                "success",
                "If that email has an account, a reset link is on its way. Open it to choose a new password.",
              );
            })
            .catch((err: unknown) => {
              fb.show("error", errorMessage(err));
            })
            .finally(() => {
              submit.disabled = false;
            });
        },
      },
    },
    [
      el("p", { class: "help", text: "We'll send a link to set a new password." }),
      email.wrapper,
      fb.node,
      el("div", { class: "form-actions" }, [submit]),
    ],
  );
  replaceChildren(container, form);
}

// ---- complete password reset (?reset_token=) --------------------------------------------------

function renderResetForm(outlet: HTMLElement, resetToken: string): void {
  const password = field({
    label: "New password",
    name: "new_password",
    type: "password",
    required: true,
    autocomplete: "new-password",
    help: "At least 8 characters.",
  });
  const fb = feedback();
  const submit = submitButton("Set new password");

  const form = el(
    "form",
    {
      class: "form",
      attrs: { novalidate: "" },
      on: {
        submit: (ev) => {
          ev.preventDefault();
          if (password.input.value.length < 8) {
            fb.show("error", "Password must be at least 8 characters.");
            return;
          }
          submit.disabled = true;
          authApi
            .resetPassword(resetToken, password.input.value)
            .then(() => {
              fb.show("success", "Password updated. You can sign in now.");
              setTimeout(() => navigate("/login"), 1200);
            })
            .catch((err: unknown) => {
              fb.show("error", errorMessage(err));
              submit.disabled = false;
            });
        },
      },
    },
    [password.wrapper, fb.node, el("div", { class: "form-actions" }, [submit])],
  );

  replaceChildren(outlet, pageHead("Choose a new password"), card([form]));
  announce("Reset password page");
}

// ---- verify email (?verify_token=) ------------------------------------------------------------

function renderVerifyFlow(outlet: HTMLElement, verifyToken: string): void {
  const status = el("div", { class: "form-feedback" }, [banner("info", "Verifying your email…")]);
  replaceChildren(outlet, pageHead("Email verification"), card([status]));

  authApi
    .verifyEmail(verifyToken)
    .then(() => {
      const user = session.getUser();
      if (user !== null) {
        session.setUser({ ...user, email_verified: true });
      }
      replaceChildren(status, banner("success", "Your email is verified. Thank you!"));
      announce("Email verified");
    })
    .catch((err: unknown) => {
      replaceChildren(status, banner("error", errorMessage(err)));
    });
}
