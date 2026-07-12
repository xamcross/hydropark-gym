// P1-27.4 support / contact. There is no support-ticket endpoint in the backend, so this view
// composes an email to SUPPORT_EMAIL (mailto). It works signed-in or signed-out.

import { SUPPORT_EMAIL } from "../config";
import { el, replaceChildren } from "../dom";
import * as session from "../session";
import { announce, banner, card, field, pageHead } from "../ui";

export function renderSupport(outlet: HTMLElement): void {
  const user = session.getUser();
  const presetEmail = user?.email ?? "";

  const emailField = field({
    label: "Your email",
    name: "from_email",
    type: "email",
    value: presetEmail,
    required: true,
    autocomplete: "email",
  });
  const subjectField = field({ label: "Subject", name: "subject", required: true });
  const messageArea = el("textarea", {
    class: "input textarea",
    attrs: { id: "support-message", name: "message", rows: "6", required: "" },
  });
  const messageWrap = el("div", { class: "field" }, [
    el("label", { class: "label", text: "Message", attrs: { for: "support-message" } }),
    messageArea,
  ]);

  const submit = el("button", { class: "btn btn-primary", text: "Compose email", attrs: { type: "submit" } });

  const form = el(
    "form",
    {
      class: "form",
      attrs: { novalidate: "" },
      on: {
        submit: (ev) => {
          ev.preventDefault();
          const subject = subjectField.input.value.trim() || "Hydropark support request";
          const bodyLines = [
            messageArea.value,
            "",
            "—",
            `From: ${emailField.input.value.trim()}`,
            user !== null ? `Account: ${user.id}` : "Account: (not signed in)",
          ];
          const href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join("\n"))}`;
          window.location.href = href;
          announce("Opening your email client");
        },
      },
    },
    [emailField.wrapper, subjectField.wrapper, messageWrap, el("div", { class: "form-actions" }, [submit])],
  );

  replaceChildren(
    outlet,
    pageHead("Support", "Questions, refunds, or account help."),
    banner("info", `Reach us any time at ${SUPPORT_EMAIL}. This form opens your email client with the details pre-filled.`),
    card([form]),
  );
  announce("Support page");
}
