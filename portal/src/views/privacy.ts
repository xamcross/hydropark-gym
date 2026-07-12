// P1-27.2 GDPR export & delete — GET /v1/account/export, POST /v1/account/delete,
// GET /v1/account/delete/{jobId}.
//
// Export returns { account, oauth_identities, note } (auth-owned data only; no conversation content
// exists server-side). Delete is an anonymise-in-place job that completes synchronously in this
// backend (returns status "completed"); we show the job, poll its status, then sign the user out
// locally since their refresh tokens are revoked as part of deletion.

import { accountApi } from "../api";
import { el, replaceChildren } from "../dom";
import { navigate } from "../router";
import * as session from "../session";
import type { AccountExport, DeletionJob } from "../types";
import {
  announce,
  badge,
  banner,
  button,
  card,
  errorMessage,
  field,
  formatDateTime,
  pageHead,
  setFlash,
  spinner,
  statusTone,
} from "../ui";

export function renderPrivacy(outlet: HTMLElement): void {
  replaceChildren(
    outlet,
    pageHead("Privacy & data", "Export or permanently delete your account data (GDPR/CCPA)."),
    exportSection(),
    deleteSection(),
  );
  announce("Privacy and data page");
}

// ---- export -----------------------------------------------------------------------------------

function exportSection(): HTMLElement {
  const output = el("div", { class: "export-output" });
  const runBtn = button("Download my data", () => run(), "primary");

  const run = (): void => {
    runBtn.disabled = true;
    replaceChildren(output, spinner("Preparing your export…"));
    accountApi
      .exportData()
      .then((data: AccountExport) => {
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const download = el("a", {
          class: "btn btn-secondary",
          text: "Save export as JSON",
          attrs: { href: url, download: "hydropark-account-export.json", role: "button" },
        });
        replaceChildren(
          output,
          banner("success", "Your data is ready."),
          el("p", { class: "help", text: data.note }),
          download,
          el("pre", { class: "code-block", attrs: { "aria-label": "Account export preview" }, text: json }),
        );
        announce("Export ready to download");
      })
      .catch((err: unknown) => {
        replaceChildren(output, banner("error", errorMessage(err)));
      })
      .finally(() => {
        runBtn.disabled = false;
      });
  };

  return card([
    el("h2", { class: "section-title", text: "Export my data" }),
    el("p", {
      class: "help",
      text: "Downloads the account data Hydropark holds (profile + linked logins). Conversations live only on your device and are never sent to the server.",
    }),
    runBtn,
    output,
  ]);
}

// ---- delete -----------------------------------------------------------------------------------

function deleteSection(): HTMLElement {
  const confirmField = field({
    label: 'Type DELETE to confirm',
    name: "confirm_delete",
    placeholder: "DELETE",
    help: "This permanently anonymises your account. Purchases records are retained for tax/legal reasons but stripped of personal data.",
  });
  const status = el("div", { class: "form-feedback" });
  const deleteBtn = button("Delete my account", () => run(), "danger");

  const showJob = (job: DeletionJob): void => {
    const dl = el("dl", { class: "receipt-grid" }, [
      el("dt", { text: "Job ID" }),
      el("dd", { class: "mono", text: job.job_id }),
      el("dt", { text: "Status" }),
      el("dd", {}, [badge(job.status, statusTone(job.status))]),
      el("dt", { text: "Requested" }),
      el("dd", { text: formatDateTime(job.requested_at) }),
      el("dt", { text: "Completed" }),
      el("dd", { text: formatDateTime(job.completed_at) }),
    ]);
    replaceChildren(status, banner(job.status === "completed" ? "success" : "info", `Deletion job ${job.status}.`), dl);
  };

  const finishAndSignOut = (): void => {
    setFlash("Your account has been deleted. You have been signed out.");
    session.signOutLocal();
    setTimeout(() => navigate("/login"), 1500);
  };

  const poll = (jobId: string, attemptsLeft: number): void => {
    accountApi
      .deletionStatus(jobId)
      .then((job) => {
        showJob(job);
        if (job.status === "completed") {
          finishAndSignOut();
        } else if (attemptsLeft > 0) {
          setTimeout(() => poll(jobId, attemptsLeft - 1), 1500);
        }
      })
      .catch((err: unknown) => {
        // After deletion the tokens are gone, so a poll may 401 -> just finish the local sign-out.
        replaceChildren(status, banner("info", errorMessage(err)));
        finishAndSignOut();
      });
  };

  const run = (): void => {
    if (confirmField.input.value.trim().toUpperCase() !== "DELETE") {
      replaceChildren(status, banner("error", 'Type "DELETE" to confirm.'));
      return;
    }
    if (!window.confirm("Permanently delete your account? This cannot be undone.")) {
      return;
    }
    deleteBtn.disabled = true;
    replaceChildren(status, spinner("Deleting your account…"));
    accountApi
      .requestDeletion()
      .then((job) => {
        showJob(job);
        if (job.status === "completed") {
          finishAndSignOut();
        } else {
          poll(job.job_id, 5);
        }
      })
      .catch((err: unknown) => {
        replaceChildren(status, banner("error", errorMessage(err)));
        deleteBtn.disabled = false;
      });
  };

  return card([
    el("h2", { class: "section-title danger-title", text: "Delete my account" }),
    el("p", {
      class: "help",
      text: "Deletion removes your email, credentials, linked logins, and devices. Owned skills already installed on your devices keep working offline; you just can't restore or re-download them afterwards.",
    }),
    confirmField.wrapper,
    deleteBtn,
    status,
  ]);
}
