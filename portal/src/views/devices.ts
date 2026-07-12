// P1-27 devices — GET /v1/devices, PATCH /v1/devices/{id} (rename), POST /v1/devices/{id}/deauthorize.
//
// Deauthorizing the LAST active device is step-up gated server-side: the backend returns
// 403 step_up_required unless a valid X-Step-Up-Token accompanies the call. Full step-up is an
// OAuth re-auth flow (POST /v1/auth/step-up/oauth/{provider}) that needs a provider id_token this
// light portal can't obtain, so we surface the requirement, let the user paste a step-up token if
// they have one, and point them at the desktop app / support otherwise.

import { devicesApi } from "../api";
import { el, replaceChildren } from "../dom";
import type { CursorPage, DeviceView } from "../types";
import {
  announce,
  badge,
  banner,
  button,
  card,
  emptyState,
  errorCode,
  errorMessage,
  field,
  formatDateTime,
  pageHead,
  spinner,
  statusTone,
} from "../ui";
import type { FieldHandle } from "../ui";

export function renderDevices(outlet: HTMLElement): void {
  const stepUp = field({
    label: "Step-up token (optional)",
    name: "step_up_token",
    type: "text",
    placeholder: "Paste an X-Step-Up-Token if prompted",
    help: "Only needed when deauthorizing your last active device.",
  });

  const note = banner(
    "info",
    "A device is a licensing slot (max 5). Rename or deauthorize to free a slot. Deauthorizing your LAST active device requires step-up re-verification.",
  );

  const tableHost = el("div", { class: "table-host" }, [spinner("Loading your devices…")]);
  const moreHost = el("div", { class: "load-more" });
  const feedback = el("div", { class: "form-feedback" });

  replaceChildren(
    outlet,
    pageHead("Devices", "Machines authorized to run your owned skills."),
    note,
    card([stepUp.wrapper]),
    feedback,
    card([tableHost, moreHost]),
  );
  announce("Devices page");

  const devices: DeviceView[] = [];

  const showFeedback = (kind: "success" | "error" | "info" | "warning", message: string): void => {
    replaceChildren(feedback, banner(kind, message));
    announce(message);
  };

  const rerender = (): void => {
    if (devices.length === 0) {
      replaceChildren(tableHost, emptyState("No devices registered yet."));
      return;
    }
    const list = el("div", { class: "device-list" });
    for (const device of devices) {
      list.append(renderDeviceRow(device, stepUp, showFeedback, reload));
    }
    replaceChildren(tableHost, list);
  };

  const reload = (): void => {
    devices.length = 0;
    replaceChildren(tableHost, spinner("Loading your devices…"));
    replaceChildren(moreHost);
    load(null);
  };

  const load = (cursor: string | null): void => {
    devicesApi
      .list(cursor)
      .then((page: CursorPage<DeviceView>) => {
        devices.push(...page.items);
        rerender();
        replaceChildren(moreHost);
        if (page.next_cursor !== null) {
          const cursorValue = page.next_cursor;
          moreHost.append(
            button(
              "Load more",
              (ev) => {
                (ev.currentTarget as HTMLButtonElement).disabled = true;
                load(cursorValue);
              },
              "secondary",
            ),
          );
        }
      })
      .catch((err: unknown) => {
        replaceChildren(tableHost, banner("error", errorMessage(err)));
      });
  };

  load(null);
}

type FeedbackFn = (kind: "success" | "error" | "info" | "warning", message: string) => void;

function renderDeviceRow(
  device: DeviceView,
  stepUp: FieldHandle,
  showFeedback: FeedbackFn,
  reload: () => void,
): HTMLElement {
  const name = device.name !== null && device.name.length > 0 ? device.name : "Unnamed device";

  const nameCol = el("div", { class: "device-name" }, [
    el("span", { class: "device-title", text: name }),
    el("span", { class: "muted mono", text: device.id }),
  ]);

  const meta = el("div", { class: "device-meta" }, [
    badge(device.status, statusTone(device.status)),
    el("span", { class: "muted", text: `Last seen ${formatDateTime(device.last_seen_at)}` }),
  ]);

  const actions = el("div", { class: "device-actions" });
  const row = el("div", { class: "device-card" }, [
    el("div", { class: "device-main" }, [nameCol, meta]),
    actions,
  ]);

  const renameBtn = button("Rename", () => startRename(), "ghost");
  const deauthBtn = button("Deauthorize", () => deauthorize(), "danger");
  actions.append(renameBtn, deauthBtn);

  function startRename(): void {
    const renameField = field({
      label: "New device name",
      name: "device_name",
      value: device.name ?? "",
      required: true,
    });
    const save = el("button", { class: "btn btn-primary", text: "Save", attrs: { type: "submit" } });
    const cancel = button("Cancel", () => rerenderRow(row, renderDeviceRow(device, stepUp, showFeedback, reload)), "ghost");

    const form = el(
      "form",
      {
        class: "form inline-form",
        on: {
          submit: (ev) => {
            ev.preventDefault();
            const next = renameField.input.value.trim();
            if (next.length === 0) {
              showFeedback("error", "Device name cannot be empty.");
              return;
            }
            save.disabled = true;
            devicesApi
              .rename(device.id, next)
              .then((updated) => {
                showFeedback("success", `Renamed to "${updated.name ?? next}".`);
                reload();
              })
              .catch((err: unknown) => {
                showFeedback("error", errorMessage(err));
                save.disabled = false;
              });
          },
        },
      },
      [renameField.wrapper, el("div", { class: "form-actions" }, [save, cancel])],
    );
    replaceChildren(row, form);
  }

  function deauthorize(): void {
    const token = stepUp.input.value.trim();
    const confirmed = window.confirm(
      `Deauthorize "${name}"? Its licenses stop being renewed and the slot is freed.`,
    );
    if (!confirmed) {
      return;
    }
    deauthBtn.disabled = true;
    devicesApi
      .deauthorize(device.id, token.length > 0 ? token : undefined)
      .then((updated) => {
        showFeedback("success", `Device "${name}" is now ${updated.status}.`);
        reload();
      })
      .catch((err: unknown) => {
        deauthBtn.disabled = false;
        if (errorCode(err) === "step_up_required") {
          showFeedback(
            "warning",
            "This is your last active device, so deauthorizing it requires step-up re-verification. " +
              "Complete step-up in the Hydropark desktop app, or paste a valid step-up token above and retry. " +
              "If you can't, contact support.",
          );
        } else {
          showFeedback("error", errorMessage(err));
        }
      });
  }

  return row;
}

function rerenderRow(oldRow: HTMLElement, newRow: HTMLElement): void {
  oldRow.replaceWith(newRow);
}
