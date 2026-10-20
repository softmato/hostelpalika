"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

import { Clock3, UserMinus } from "@/components/icons";
import { memo, useCallback, useState } from "react";

import { EmptyState, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { InitialsAvatar, ListPager, MetricCard, RoleButton } from "@/app/_components/portal-dashboard-ui";
import { FactChip } from "@/app/_components/platform-page-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  return Number.isNaN(date.getTime()) ? "—" : formatHostelDate(date);
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
    const [decidingId, setDecidingId] = useState<string | null>(null);
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
    const deciding = requests.find((request) => request.id === decidingId) ?? null;

    /** Closes the dialog first, so Approve's own confirm is the only modal up. */
    const decide = (id: string, decision: "APPROVED" | "REJECTED") => {
      setDecidingId(null);
      void review(id, decision);
    };

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        {confirmDialog}
        <PageHeader
          description="Owners who asked to close their account; nothing happens until you approve."
          icon={UserMinus}
          title="Account Deletion Requests"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={Clock3}
            label="Waiting on you"
            tone={pending > 0 ? "amber" : "teal"}
            value={pending}
          />
          <MetricCard icon={UserMinus} label="Requests" value={queue.pagination?.total ?? requests.length} />
        </div>

        <Panel>
          {requests.length === 0 ? (
            <EmptyState label="No account deletion requests." />
          ) : null}
          <div className="grid gap-3 lg:grid-cols-2">
            {requests.map((request) => (
              <div
                className="space-y-3 rounded-2xl border border-border/70 bg-card p-4"
                key={request.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <InitialsAvatar name={request.requestedName ?? request.requestedEmail} size="sm" tone="team" />
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-semibold text-foreground">
                        {request.requestedName ?? request.requestedEmail}
                      </p>
                      <p className="truncate text-[12px] text-muted-foreground">{request.requestedEmail}</p>
                    </div>
                  </div>
                  <StatusBadge>{request.reviewStatus ?? "PENDING"}</StatusBadge>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="person">{request.requestedRole.replaceAll("_", " ").toLowerCase()}</FactChip>
                  <FactChip glyph="calendar">{`Asked ${formatDate(request.requestedAt)}`}</FactChip>
                  {request.hostelIds.length > 0 ? (
                    <FactChip glyph="business" tone="amber">
                      {`${request.hostelIds.length} hostel${request.hostelIds.length === 1 ? "" : "s"} attached`}
                    </FactChip>
                  ) : null}
                  {request.scheduledDeletionAt ? (
                    <FactChip glyph="time" tone="rose">{`Erases ${formatDate(request.scheduledDeletionAt)}`}</FactChip>
                  ) : null}
                </div>

                <p className="text-[13.5px] text-foreground">“{request.reason}”</p>

                {request.reviewStatus === "PENDING" ? (
                  <RoleButton disabled={busyId === request.id} onClick={() => setDecidingId(request.id)} type="button">
                    Decide
                  </RoleButton>
                ) : (
                  <p className="text-[12px] text-muted-foreground">
                    Reviewed {formatDate(request.reviewedAt)}
                    {request.reviewNote ? ` — “${request.reviewNote}”` : ""}
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

        <Dialog onOpenChange={(open) => (open ? null : setDecidingId(null))} open={deciding !== null}>
          <DialogContent className="sm:max-w-md">
            {deciding ? (
              <>
                <DialogHeader>
                  <DialogTitle>{deciding.requestedName ?? deciding.requestedEmail}</DialogTitle>
                  <DialogDescription>
                    {deciding.hostelIds.length > 0
                      ? "Check their hostels are handed over first; approving closes the account now and erases it in 60 days."
                      : "Approving closes the account now and erases it in 60 days."}
                  </DialogDescription>
                </DialogHeader>
                <p className="text-[13.5px] text-foreground">“{deciding.reason}”</p>
                <label className="block text-[12px] font-semibold text-foreground">
                  Note (optional)
                  <textarea
                    className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] font-normal"
                    onChange={(event) =>
                      setNote((current) => ({
                        ...current,
                        [deciding.id]: event.target.value,
                      }))
                    }
                    rows={2}
                    value={note[deciding.id] ?? ""}
                  />
                </label>
                <DialogFooter className="sm:justify-between">
                  <Button onClick={() => decide(deciding.id, "REJECTED")} type="button" variant="outline">
                    Decline
                  </Button>
                  <Button onClick={() => decide(deciding.id, "APPROVED")} type="button" variant="destructive">
                    Approve deletion
                  </Button>
                </DialogFooter>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);
