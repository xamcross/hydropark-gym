// P1-27 purchases, receipts & invoices — GET /v1/orders (cursor-paginated). Renders order history
// and a client-side printable receipt per order. Official tax invoices are issued/emailed by Stripe
// (SPEC §13.10); there is no invoice-document endpoint in the backend to fetch, so the receipt is
// composed from the order projection.

import { ordersApi } from "../api";
import { el, replaceChildren } from "../dom";
import type { CursorPage, OrderView } from "../types";
import {
  announce,
  badge,
  banner,
  button,
  card,
  emptyState,
  errorMessage,
  formatDateTime,
  formatMoney,
  pageHead,
  spinner,
  statusTone,
} from "../ui";

const KIND_LABEL: Record<string, string> = {
  skill: "Skill",
  bundle: "Bundle",
  wallet_topup: "Wallet top-up",
};

const SOURCE_LABEL: Record<string, string> = {
  mor: "Card (Stripe)",
  wallet: "Wallet balance",
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

export function renderPurchases(outlet: HTMLElement): void {
  const note = banner(
    "info",
    "Official tax receipts/invoices are issued by Stripe and emailed at purchase (SPEC §13.10). Your order history is below.",
  );
  const tableHost = el("div", { class: "table-host" }, [spinner("Loading your orders…")]);
  const moreHost = el("div", { class: "load-more" });

  replaceChildren(outlet, pageHead("Purchases & receipts"), note, card([tableHost, moreHost]));
  announce("Purchases page");

  const rows: OrderView[] = [];

  const loadMoreButton = (cursor: string): HTMLButtonElement =>
    button(
      "Load more",
      (ev) => {
        const btn = ev.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        load(cursor);
      },
      "secondary",
    );

  const render = (): void => {
    if (rows.length === 0) {
      replaceChildren(tableHost, emptyState("No purchases yet. Skills you buy will appear here."));
      return;
    }
    replaceChildren(tableHost, buildTable(rows));
  };

  const load = (cursor: string | null): void => {
    ordersApi
      .list(cursor)
      .then((page: CursorPage<OrderView>) => {
        rows.push(...page.items);
        render();
        replaceChildren(moreHost);
        if (page.next_cursor !== null) {
          moreHost.append(loadMoreButton(page.next_cursor));
        }
      })
      .catch((err: unknown) => {
        replaceChildren(tableHost, banner("error", errorMessage(err)));
      });
  };

  load(null);
}

function buildTable(orders: ReadonlyArray<OrderView>): HTMLElement {
  const head = el("thead", {}, [
    el("tr", {}, [
      el("th", { text: "Date", attrs: { scope: "col" } }),
      el("th", { text: "Item", attrs: { scope: "col" } }),
      el("th", { text: "Amount", attrs: { scope: "col" } }),
      el("th", { text: "Paid with", attrs: { scope: "col" } }),
      el("th", { text: "Status", attrs: { scope: "col" } }),
      el("th", { text: "Receipt", attrs: { scope: "col" } }),
    ]),
  ]);

  const body = el("tbody");
  for (const order of orders) {
    body.append(
      el("tr", {}, [
        el("td", { attrs: { "data-label": "Date" } }, [
          el("span", { text: formatDateTime(order.created_at) }),
        ]),
        el("td", { attrs: { "data-label": "Item" } }, [
          el("div", { class: "cell-stack" }, [
            el("span", { text: kindLabel(order.kind) }),
            el("span", { class: "muted mono", text: order.target_id }),
          ]),
        ]),
        el("td", { attrs: { "data-label": "Amount" } }, [
          el("span", { text: formatMoney(order.amount, order.currency) }),
        ]),
        el("td", { attrs: { "data-label": "Paid with" }, text: sourceLabel(order.payment_source) }),
        el("td", { attrs: { "data-label": "Status" } }, [
          badge(order.status, statusTone(order.status)),
        ]),
        el("td", { attrs: { "data-label": "Receipt" } }, [
          button("View", () => openReceipt(order), "ghost"),
        ]),
      ]),
    );
  }

  const table = el("table", { class: "data-table" }, [head, body]);
  return el("div", { class: "table-scroll" }, [table]);
}

// ---- printable receipt (client-composed from the order) ---------------------------------------

function openReceipt(order: OrderView): void {
  const existing = document.getElementById("receipt-dialog");
  if (existing !== null) {
    existing.remove();
  }

  const rows: ReadonlyArray<[string, string]> = [
    ["Order ID", order.order_id],
    ["Date", formatDateTime(order.created_at)],
    ["Item type", kindLabel(order.kind)],
    ["Item", order.target_id],
    ["Amount", formatMoney(order.amount, order.currency)],
    ["Currency", order.currency],
    ["Payment", sourceLabel(order.payment_source)],
    ["Status", order.status],
  ];

  const dl = el("dl", { class: "receipt-grid" });
  for (const [term, value] of rows) {
    dl.append(el("dt", { text: term }), el("dd", { text: value, class: value === order.order_id || value === order.target_id ? "mono" : "" }));
  }

  const dialog = el(
    "dialog",
    { class: "dialog", attrs: { id: "receipt-dialog", "aria-label": "Order receipt" } },
    [
      el("div", { class: "receipt", attrs: { id: "receipt-printable" } }, [
        el("div", { class: "receipt-head" }, [
          el("strong", { text: "Hydropark" }),
          el("span", { class: "muted", text: "Order receipt" }),
        ]),
        dl,
        el("p", {
          class: "help",
          text: "This is an order summary. Your official VAT/tax invoice is issued by Stripe and emailed to you.",
        }),
      ]),
      el("div", { class: "dialog-actions" }, [
        button("Print", () => window.print(), "secondary"),
        button(
          "Close",
          () => {
            dialog.close();
            dialog.remove();
          },
          "ghost",
        ),
      ]),
    ],
  );

  document.body.append(dialog);
  dialog.showModal();
}
