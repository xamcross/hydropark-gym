// P1-27.3 refund request — 14-day window (SPEC §13.7).
//
// IMPORTANT: the backend exposes NO refund endpoint (there is no POST /v1/orders/{id}/refund or
// equivalent anywhere in the controllers — a refund is applied server-side out of band, e.g. via
// Stripe, and only its EFFECT surfaces here as an order status of "refunded"/"charged_back" and an
// entitlement status change). Per task instructions we do NOT invent an endpoint: eligible orders
// get a "Request refund" action that composes a support request (mailto) with the order pre-filled,
// and the support/contact flow (P1-27.4) handles it from there.

import { ordersApi } from "../api";
import { SUPPORT_EMAIL, REFUND_WINDOW_DAYS } from "../config";
import { el, replaceChildren } from "../dom";
import { navigate } from "../router";
import type { CursorPage, OrderView } from "../types";
import {
  announce,
  badge,
  banner,
  button,
  card,
  daysSince,
  emptyState,
  errorMessage,
  formatDateTime,
  formatMoney,
  pageHead,
  spinner,
  statusTone,
} from "../ui";

interface Eligibility {
  eligible: boolean;
  reason: string;
}

function assess(order: OrderView): Eligibility {
  if (order.status !== "paid") {
    return { eligible: false, reason: `Not refundable (status: ${order.status}).` };
  }
  const age = daysSince(order.created_at);
  if (age === null) {
    return { eligible: false, reason: "Purchase date unavailable." };
  }
  if (age > REFUND_WINDOW_DAYS) {
    return { eligible: false, reason: `Outside the ${REFUND_WINDOW_DAYS}-day window (purchased ${age} days ago).` };
  }
  const remaining = REFUND_WINDOW_DAYS - age;
  return { eligible: true, reason: `Eligible — ${remaining} day(s) left in the ${REFUND_WINDOW_DAYS}-day window.` };
}

function refundMailto(order: OrderView): string {
  const subject = `Refund request: order ${order.order_id}`;
  const lines = [
    "Hi Hydropark support,",
    "",
    "I'd like to request a refund for the following order:",
    `  Order ID: ${order.order_id}`,
    `  Item: ${order.kind} / ${order.target_id}`,
    `  Amount: ${formatMoney(order.amount, order.currency)} (${order.currency})`,
    `  Purchased: ${formatDateTime(order.created_at)}`,
    "",
    "Reason: ",
    "",
    "Thank you.",
  ];
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

export function renderRefund(outlet: HTMLElement): void {
  const host = el("div", { class: "table-host" }, [spinner("Loading your purchases…")]);
  replaceChildren(
    outlet,
    pageHead("Request a refund", `Refunds are available within ${REFUND_WINDOW_DAYS} days of purchase.`),
    banner(
      "info",
      `Refunds within ${REFUND_WINDOW_DAYS} days are handled by our support team — there is no automated refund button. ` +
        "Select an eligible purchase below to start a pre-filled request.",
    ),
    card([host]),
  );
  announce("Refund request page");

  const orders: OrderView[] = [];
  const moreHost = el("div", { class: "load-more" });

  const rerender = (): void => {
    const refundable = orders.filter((o) => o.kind !== "wallet_topup");
    if (refundable.length === 0) {
      replaceChildren(host, emptyState("No refundable purchases found."), moreHost);
      return;
    }
    const list = el("div", { class: "refund-list" });
    for (const order of refundable) {
      const verdict = assess(order);
      const action = verdict.eligible
        ? el("a", { class: "btn btn-primary", text: "Request refund", attrs: { href: refundMailto(order), role: "button" } })
        : button("Contact support", () => navigate("/support"), "ghost");

      list.append(
        el("div", { class: "refund-row" }, [
          el("div", { class: "refund-info" }, [
            el("div", { class: "cell-stack" }, [
              el("span", { text: `${order.kind} — ${order.target_id}`, class: "mono" }),
              el("span", { class: "muted", text: `${formatMoney(order.amount, order.currency)} · ${formatDateTime(order.created_at)}` }),
            ]),
            el("div", { class: "refund-status" }, [
              badge(order.status, statusTone(order.status)),
              el("span", { class: verdict.eligible ? "help ok-text" : "help", text: verdict.reason }),
            ]),
          ]),
          action,
        ]),
      );
    }
    replaceChildren(host, list, moreHost);
  };

  const load = (cursor: string | null): void => {
    ordersApi
      .list(cursor)
      .then((page: CursorPage<OrderView>) => {
        orders.push(...page.items);
        rerender();
        replaceChildren(moreHost);
        if (page.next_cursor !== null) {
          const next = page.next_cursor;
          moreHost.append(
            button(
              "Load more",
              (ev) => {
                (ev.currentTarget as HTMLButtonElement).disabled = true;
                load(next);
              },
              "secondary",
            ),
          );
        }
      })
      .catch((err: unknown) => {
        replaceChildren(host, banner("error", errorMessage(err)));
      });
  };

  load(null);
}
