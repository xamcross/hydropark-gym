// P1-27 entitlements — GET /v1/entitlements. Each row is { skill_id, status }.
// status "owned" == >=1 active grant; a terminal status ("refunded" | "charged_back" | "revoked")
// means the skill is disabled + reinstall-blocked on the device's next online launch (SPEC §13.7).

import { entitlementsApi } from "../api";
import { el, replaceChildren } from "../dom";
import type { EntitlementView } from "../types";
import {
  announce,
  badge,
  banner,
  card,
  emptyState,
  errorMessage,
  pageHead,
  spinner,
  statusTone,
} from "../ui";

const STATUS_HELP: Record<string, string> = {
  owned: "Active — usable offline forever.",
  refunded: "Refunded — disabled on this skill's next online launch.",
  charged_back: "Charged back — disabled on next online launch.",
  revoked: "Revoked — disabled on next online launch.",
};

export function renderEntitlements(outlet: HTMLElement): void {
  const host = el("div", { class: "table-host" }, [spinner("Loading your entitlements…")]);
  replaceChildren(
    outlet,
    pageHead("Entitlements", "The skills your account owns."),
    banner(
      "info",
      "“Owned” means at least one active grant. A refunded, charged-back, or revoked skill is disabled the next time that device is online (SPEC §13.7).",
    ),
    card([host]),
  );
  announce("Entitlements page");

  entitlementsApi
    .list()
    .then((rows: EntitlementView[]) => {
      if (rows.length === 0) {
        replaceChildren(host, emptyState("You don't own any skills yet."));
        return;
      }
      const list = el("ul", { class: "entitlement-list" });
      for (const row of rows) {
        list.append(
          el("li", { class: "entitlement" }, [
            el("div", { class: "entitlement-main" }, [
              el("span", { class: "mono", text: row.skill_id }),
              el("span", { class: "help", text: STATUS_HELP[row.status] ?? row.status }),
            ]),
            badge(row.status, statusTone(row.status)),
          ]),
        );
      }
      replaceChildren(host, list);
    })
    .catch((err: unknown) => {
      replaceChildren(host, banner("error", errorMessage(err)));
    });
}
