// Shared, accessible UI widgets + formatting helpers built on top of `dom.ts`.

import { ApiError } from "./apiClient";
import { el } from "./dom";

// ---- feedback / a11y --------------------------------------------------------------------------

/** Announce a message to the visually-hidden aria-live region (see index.html #live-region). */
export function announce(message: string): void {
  const region = document.getElementById("live-region");
  if (region !== null) {
    region.textContent = message;
  }
}

/** One-shot cross-view notice (e.g. "session expired"), survives a single navigation. */
export function setFlash(message: string): void {
  sessionStorage.setItem("hp.flash", message);
}

export function consumeFlash(): string | null {
  const message = sessionStorage.getItem("hp.flash");
  if (message !== null) {
    sessionStorage.removeItem("hp.flash");
  }
  return message;
}

// ---- primitives -------------------------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export function button(
  label: string,
  onClick: (ev: MouseEvent) => void,
  variant: ButtonVariant = "primary",
  attrs: Record<string, string> = {},
): HTMLButtonElement {
  return el("button", {
    class: `btn btn-${variant}`,
    text: label,
    attrs: { type: "button", ...attrs },
    on: { click: onClick },
  });
}

export type BannerKind = "info" | "success" | "error" | "warning";

export function banner(kind: BannerKind, message: string): HTMLDivElement {
  return el("div", {
    class: `banner banner-${kind}`,
    text: message,
    attrs: { role: kind === "error" ? "alert" : "status" },
  });
}

export function badge(text: string, tone: string): HTMLSpanElement {
  return el("span", { class: `badge badge-${tone}`, text });
}

export interface FieldSpec {
  label: string;
  name: string;
  type?: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
  help?: string;
}

export interface FieldHandle {
  wrapper: HTMLDivElement;
  input: HTMLInputElement;
}

let fieldSeq = 0;

/** A labelled input with a stable id/for association and optional help text. */
export function field(spec: FieldSpec): FieldHandle {
  fieldSeq += 1;
  const id = `f-${spec.name}-${fieldSeq}`;
  const attrs: Record<string, string> = { id, name: spec.name, type: spec.type ?? "text" };
  if (spec.placeholder !== undefined) {
    attrs["placeholder"] = spec.placeholder;
  }
  if (spec.required === true) {
    attrs["required"] = "";
  }
  if (spec.autocomplete !== undefined) {
    attrs["autocomplete"] = spec.autocomplete;
  }
  const input = el("input", { class: "input", attrs });
  if (spec.value !== undefined) {
    input.value = spec.value;
  }
  const children: Array<Node | string> = [
    el("label", { class: "label", text: spec.label, attrs: { for: id } }),
    input,
  ];
  if (spec.help !== undefined) {
    children.push(el("p", { class: "help", text: spec.help }));
  }
  const wrapper = el("div", { class: "field" }, children);
  return { wrapper, input };
}

export function pageHead(title: string, subtitle?: string): HTMLElement {
  const children: Array<Node | string> = [el("h1", { class: "page-title", text: title })];
  if (subtitle !== undefined) {
    children.push(el("p", { class: "page-sub", text: subtitle }));
  }
  return el("header", { class: "page-head" }, children);
}

export function card(children: ReadonlyArray<Node | string>): HTMLElement {
  return el("section", { class: "card" }, children);
}

export function spinner(label = "Loading…"): HTMLElement {
  return el("div", { class: "loading", attrs: { role: "status" } }, [
    el("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
    el("span", { text: label }),
  ]);
}

export function emptyState(message: string): HTMLElement {
  return el("p", { class: "empty", text: message });
}

// ---- formatting -------------------------------------------------------------------------------

/** Minor units (cents) + ISO currency -> localized display string. Falls back if the currency is
 *  unknown to Intl. Note: assumes a 2-decimal currency (true for USD/EUR/GBP; a few are not). */
export function formatMoney(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

/** Days elapsed since an ISO timestamp (floored), or null if unparseable. */
export function daysSince(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === "") {
    return null;
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return null;
  }
  return Math.floor((Date.now() - then) / 86_400_000);
}

// ---- errors -----------------------------------------------------------------------------------

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

/** Map an order/entitlement/device status string to a badge tone class. */
export function statusTone(status: string): string {
  switch (status) {
    case "paid":
    case "owned":
    case "active":
    case "completed":
      return "ok";
    case "pending":
      return "pending";
    case "refunded":
    case "revoked":
      return "warn";
    case "failed":
    case "charged_back":
    case "deauthorized":
      return "danger";
    default:
      return "neutral";
  }
}
