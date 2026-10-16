"use client";

import { ShieldAlert } from "@/components/icons";
import { memo, useCallback, useState } from "react";

import { Panel } from "@/app/_components/shared-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

type DeletionPathway =
  | "BLOCKED"
  | "GUARDIAN_RELEASE"
  | "PLATFORM_REVIEW"
  | "SELF_SERVICE";

type DeletionStatus = {
  blockedReason?: string;
  graceperiodDays: number;
  hostelNames: string[];
  pathway: DeletionPathway;
  request: {
    kind: string;
    reason: string;
    requestedAt: string;
    reviewStatus?: string;
    scheduledDeletionAt?: string;
  } | null;
};

/**
 * The copy has to tell the truth *before* the click, because "delete my
 * account" means four different things here depending on who is asking. A
 * guardian who presses this loses their access to a resident, not their
 * account; an owner starts a conversation with the platform, not a countdown.
 */
const PATHWAY_COPY: Record<
  DeletionPathway,
  {
    action: string;
    body: string;
    confirmDescription: string;
    confirmTitle: string;
    heading: string;
  }
> = {
  BLOCKED: {
    action: "",
    body: "",
    confirmDescription: "",
    confirmTitle: "",
    heading: "Your account cannot be deleted right now",
  },
  GUARDIAN_RELEASE: {
    action: "Remove my guardian access",
    heading: "Remove your guardian access",
    body: "You are here as a guardian. Removing your access stops you seeing your resident's information and turns this into an ordinary account — it does not erase you from this platform. Once it is an ordinary account you can delete it outright from this same page.",
    confirmDescription:
      "You will immediately stop seeing your resident's attendance, payments and complaints. Getting it back needs a fresh invitation from them. Your account itself stays.",
    confirmTitle: "Remove your guardian access?",
  },
  PLATFORM_REVIEW: {
    action: "Send my request to the platform owner",
    heading: "Ask the platform owner to close your account",
    body: "Your hostel's residents, payments and staff all hang off this account, so it cannot be deleted on the spot. Tell us why and we will pass the request to the platform owner. Nothing changes on your account, and you can keep working normally, until they act on it.",
    confirmDescription:
      "Your reason goes to the platform owner for review. Nothing changes on your account or your hostel in the meantime — you can keep working normally until they act on it.",
    confirmTitle: "Send this request to the platform owner?",
  },
  SELF_SERVICE: {
    action: "Delete my account",
    heading: "Delete your account",
    body: "Your account closes immediately and everything is permanently erased after 60 days. During those 60 days you can undo it using the link we email you. Payment and audit records are kept with your name removed — hostels are required to keep their own accounts.",
    confirmDescription:
      "You will be signed out and will not be able to sign in again. Everything is permanently erased in 60 days — until then you can undo this using the link we email you.",
    confirmTitle: "Close your account?",
  },
};

export const AccountDeletionPanel = memo(function AccountDeletionPanel() {
  const status = usePortalResource<DeletionStatus>("/api/v1/users/account-deletion", {
    errorMessage: "Could not load your account settings.",
  });
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const { refreshAsync } = status;
  // Resolved before `submit` so the callback can close over it — the early
  // return for the loading state sits below every hook.
  const copy = status.data ? PATHWAY_COPY[status.data.pathway] : null;

  const submit = useCallback(async () => {
    // Last gate before something that closes an account, revokes guardian
    // access, or goes to the platform owner. The copy is pathway-specific
    // because the consequence is.
    if (!copy) {
      return;
    }

    const confirmed = await confirm({
      actionLabel: copy.action,
      description: copy.confirmDescription,
      title: copy.confirmTitle,
      tone: "destructive",
    });

    if (!confirmed) {
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const result = await browserApi<{ message: string }>(
        "/api/v1/users/account-deletion",
        { body: JSON.stringify({ reason }), method: "POST" },
      );

      setMessage(result.message);
      setConfirming(false);
      setReason("");
      await refreshAsync();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not submit that request.",
      );
    } finally {
      setBusy(false);
    }
  }, [confirm, copy, reason, refreshAsync]);

  const data = status.data;

  if (!data || !copy) {
    return null;
  }

  const open = data.request;

  return (
    <Panel>
      {confirmDialog}
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-lg font-semibold text-foreground">{copy.heading}</h2>

          {data.pathway === "BLOCKED" ? (
            <p className="text-sm text-muted-foreground">{data.blockedReason}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.body}</p>
          )}

          {data.pathway === "PLATFORM_REVIEW" && data.hostelNames.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Attached to this account: <strong>{data.hostelNames.join(", ")}</strong>.
            </p>
          ) : null}

          <Message value={message} />

          {open ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              {open.kind === "PLATFORM_REVIEW" ? (
                <p>
                  Your request is with the platform owner
                  {open.reviewStatus ? ` (${open.reviewStatus.toLowerCase()})` : ""}.
                  Your account is unaffected in the meantime.
                </p>
              ) : (
                <p>
                  Your account is closed and will be erased on{" "}
                  <strong>
                    {open.scheduledDeletionAt
                      ? new Date(open.scheduledDeletionAt).toLocaleDateString()
                      : "the scheduled date"}
                  </strong>
                  . Use the link in your email to undo it.
                </p>
              )}
            </div>
          ) : data.pathway === "BLOCKED" ? null : confirming ? (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="text-muted-foreground">
                  {data.pathway === "GUARDIAN_RELEASE"
                    ? "Why are you leaving? (optional context for the hostel)"
                    : "Why are you leaving? This is required."}
                </span>
                <textarea
                  className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  value={reason}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
                  disabled={busy || reason.trim().length < 10}
                  onClick={submit}
                  type="button"
                >
                  {busy ? "Submitting…" : copy.action}
                </button>
                <button
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium"
                  onClick={() => setConfirming(false)}
                  type="button"
                >
                  Keep my account
                </button>
              </div>
              {reason.trim().length < 10 ? (
                <p className="text-xs text-muted-foreground">
                  Add a sentence or two before continuing.
                </p>
              ) : null}
            </div>
          ) : (
            <button
              className="rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive"
              onClick={() => setConfirming(true)}
              type="button"
            >
              {copy.action}
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
});
