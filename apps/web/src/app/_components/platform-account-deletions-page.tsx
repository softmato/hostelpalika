"use client";

import { UserMinus } from "@/components/icons";
import { memo, useCallback, useState } from "react";

import { EmptyState, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { ListPager } from "@/app/_components/portal-dashboard-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { browserApi } from "@/lib/browser-api";
import { usePagedPortalResource } from "@/lib/portal-pagination";
import { Message, PageHeader } from "./core-portal-shared";

type DeletionRequest = {
  hostelIds: string[];
  id: string;
  reason: string;
  requestedAt: string;
  requestedEmail: string;
  requestedName?: string;
  requestedRole: string;
  reviewNote?: string;
  reviewStatus?: string;
  reviewedAt?: string;
  scheduledDeletionAt?: string;
};

type DeletionQueue = {
  pendingCount: number;
  requests: DeletionRequest[];
};

function formatDate(value?: string) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export const PlatformAccountDeletionsPageContent = memo(
  function PlatformAccountDeletionsPageContent() {
    const queue = usePagedPortalResource<DeletionQueue>(
      "/api/v1/platform/account-deletions",
      { errorMessage: "Could not load account deletion requests." },
    );
    const [message, setMessage] = useState("");
    const [note, setNote] = useState<Record<string, string>>({});
    const [busyId, setBusyId] = useState<string | null>(null);
    const { confirm, confirmDialog } = useConfirm();

    const { refreshAsync } = queue;

    const review = useCallback(
      async (id: string, decision: "APPROVED" | "REJECTED") => {
        // Approving closes someone's account and starts an erasure clock, so it
        // does not happen on a single click.
        if (decision === "APPROVED") {
          const confirmed = await confirm({
            actionLabel: "Approve deletion",
            description:
              "Their account closes immediately and everything is permanently erased in 60 days. Check any hostels on the account have been handed over first — they can still cancel using the link we email them.",
            title: "Approve this account deletion?",
            tone: "destructive",
          });

          if (!confirmed) {
            return;
          }
        }

        setBusyId(id);
        setMessage("");

        try {
          await browserApi(`/api/v1/platform/account-deletions/${id}/review`, {
            body: JSON.stringify({ decision, note: note[id] }),
            method: "POST",
          });
          setMessage(
            decision === "APPROVED"
              ? "Approved. The account is closed and will be erased in 60 days."
              : "Declined. The account is untouched and they can ask again.",
          );
          await refreshAsync();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not record that decision.",
          );
        } finally {
          setBusyId(null);
        }
      },
      [confirm, note, refreshAsync],
    );

    const requests = queue.data?.requests ?? [];
    const pending = queue.data?.pendingCount ?? 0;

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        {confirmDialog}
        <PageHeader
          description={
            pending > 0
              ? `${pending} request${pending === 1 ? "" : "s"} waiting on you. Approving closes the account and starts a 60-day countdown they can still cancel.`
              : "Hostel owners who have asked for their account to be deleted. Nothing happens to an account until you approve it."
          }
          icon={UserMinus}
          title="Account Deletion Requests"
        />
        <Message value={message} />
        <Panel>
          {requests.length === 0 ? (
            <EmptyState label="No account deletion requests." />
          ) : null}
          <div className="space-y-4">
            {requests.map((request) => (
              <div
                className="rounded-xl border border-border p-4"
                key={request.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">
                      {request.requestedName ?? request.requestedEmail}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {request.requestedEmail} · {request.requestedRole} · asked{" "}
                      {formatDate(request.requestedAt)}
                    </p>
                  </div>
                  <StatusBadge>{request.reviewStatus ?? "PENDING"}</StatusBadge>
                </div>

                <p className="mt-3 text-sm text-foreground">“{request.reason}”</p>

                {request.hostelIds.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {request.hostelIds.length} hostel
                    {request.hostelIds.length === 1 ? "" : "s"} attached to this account —
                    check they have been handed over before approving.
                  </p>
                ) : null}

                {request.reviewStatus === "PENDING" ? (
                  <div className="mt-4 space-y-3">
                    <label className="block text-sm">
                      <span className="text-muted-foreground">Note (optional)</span>
                      <textarea
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        onChange={(event) =>
                          setNote((current) => ({
                            ...current,
                            [request.id]: event.target.value,
                          }))
                        }
                        rows={2}
                        value={note[request.id] ?? ""}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
                        disabled={busyId === request.id}
                        onClick={() => review(request.id, "APPROVED")}
                        type="button"
                      >
                        Approve deletion
                      </button>
                      <button
                        className="rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
                        disabled={busyId === request.id}
                        onClick={() => review(request.id, "REJECTED")}
                        type="button"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Reviewed {formatDate(request.reviewedAt)}
                    {request.reviewNote ? ` — “${request.reviewNote}”` : ""}
                    {request.scheduledDeletionAt
                      ? ` · erases ${formatDate(request.scheduledDeletionAt)}`
                      : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
          <ListPager
            onPageChange={queue.setPage}
            page={queue.page}
            pageSize={queue.pagination?.pageSize}
            total={queue.pagination?.total ?? 0}
            unit="requests"
          />
        </Panel>
      </div>
    );
  },
);
