"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";
import { HOSTEL_LEAVE_SECTIONS, type HostelLeaveSection } from "@hostel/shared/constants/hostel-leave";

import { CircleAlert, Clock3, DoorOpen } from "@/components/icons";
import { useSearchParams } from "next/navigation";
import { memo, useCallback, useState } from "react";

import { EmptyState, LoadingRows, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { MetricCard, RoleButton } from "@/app/_components/portal-dashboard-ui";
import { FactChip } from "@/app/_components/platform-page-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { Message, PageHeader } from "./core-portal-shared";

type LeaveRequest = {
  branchCount: number;
  exportSections: string[];
  exportSentAt: string | null;
  exportSentTo: string | null;
  holdDays: number;
  holdUntil: string | null;
  hostelName: string;
  id: string;
  ownerEmail: string | null;
  ownerName: string | null;
  reason: string;
  reclaimedAt: string | null;
  requestedAt: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  status: "APPROVED" | "CANCELLED" | "PENDING" | "RECLAIMED" | "REJECTED";
};

type LeaveDetail = {
  blockers: { code: string; message: string }[];
  branches: { id: string; name: string }[];
  hostel: { erased: boolean; isArchived?: boolean; since?: string | null };
  request: LeaveRequest;
};

const FILTERS = [
  { key: "PENDING", label: "Waiting" },
  { key: "APPROVED", label: "Approved" },
  { key: "ALL", label: "All" },
] as const;

const STATUS_TEXT: Record<LeaveRequest["status"], string> = {
  APPROVED: "Off the platform",
  CANCELLED: "Cancelled by owner",
  PENDING: "Waiting",
  RECLAIMED: "Claimed back",
  REJECTED: "Not approved",
};

const date = (value?: string | null) => (value ? formatHostelDate(value, "—") : "—");

/**
 * Hostels asking to leave (docs/HOSTEL_LEAVE_PLATFORM.md). Approving emails the
 * ticked data to the owner first, then takes the hostel off for its hold.
 */
export const PlatformHostelLeavesPageContent = memo(function PlatformHostelLeavesPageContent() {
  const params = useSearchParams();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("PENDING");
  const [openId, setOpenId] = useState<string | null>(params.get("request"));
  const [message, setMessage] = useState("");
  const queue = usePortalResource<{ requests: LeaveRequest[] }>(`/api/v1/platform/hostel-leaves?status=${filter}`, {
    errorMessage: "Could not load leave requests.",
  });
  const requests = queue.data?.requests ?? [];

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PageHeader
        description="Hostels asking to leave. Nothing happens until you approve."
        icon={DoorOpen}
        title="Hostel Leaves"
      />
      <Message value={message || queue.message} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Clock3}
          label={filter === "PENDING" ? "Waiting on you" : "Shown"}
          tone={filter === "PENDING" && requests.length > 0 ? "amber" : "teal"}
          value={requests.length}
        />
      </div>

      <div className="flex gap-2">
        {FILTERS.map((entry) => (
          <Button
            className="h-9 rounded-xl"
            key={entry.key}
            onClick={() => setFilter(entry.key)}
            type="button"
            variant={filter === entry.key ? "default" : "outline"}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      <Panel>
        {queue.state === "loading" ? <LoadingRows /> : null}
        {queue.state === "ready" && requests.length === 0 ? <EmptyState label="No requests here." /> : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {requests.map((request) => (
            <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-4" key={request.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-semibold text-foreground">{request.hostelName}</p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {[request.ownerName, request.ownerEmail].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <StatusBadge>{STATUS_TEXT[request.status]}</StatusBadge>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <FactChip glyph="calendar">{`Asked ${date(request.requestedAt)}`}</FactChip>
                <FactChip glyph="time">{`Hold ${request.holdDays} days`}</FactChip>
                {request.holdUntil && request.status === "APPROVED" ? (
                  <FactChip glyph="time" tone="rose">{`Erases ${date(request.holdUntil)}`}</FactChip>
                ) : null}
                {request.branchCount > 0 ? (
                  <FactChip glyph="business" tone="amber">{`${request.branchCount} branch${request.branchCount === 1 ? "" : "es"}`}</FactChip>
                ) : null}
              </div>
              <p className="text-[13.5px] text-foreground">“{request.reason}”</p>
              {request.status === "PENDING" ? (
                <RoleButton onClick={() => setOpenId(request.id)} type="button">
                  Review
                </RoleButton>
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  {request.exportSentTo
                    ? `Data sent to ${request.exportSentTo} — ${request.exportSections.length} file${request.exportSections.length === 1 ? "" : "s"}`
                    : `Reviewed ${date(request.reviewedAt)}`}
                  {request.reviewNote ? ` — “${request.reviewNote}”` : ""}
                </p>
              )}
            </div>
          ))}
        </div>
      </Panel>

      {/* Keyed so each request opens with every section ticked and an empty note. */}
      <ReviewDialog
        key={openId ?? "closed"}
        onClose={() => setOpenId(null)}
        onDone={async (text) => {
          setOpenId(null);
          setMessage(text);
          await queue.refreshAsync();
        }}
        requestId={openId}
      />
    </div>
  );
});

function ReviewDialog({
  onClose,
  onDone,
  requestId,
}: {
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  requestId: string | null;
}) {
  const detail = usePortalResource<LeaveDetail>(requestId ? `/api/v1/platform/hostel-leaves/${requestId}` : null, {
    errorMessage: "Could not load this request.",
  });
  const [sections, setSections] = useState<HostelLeaveSection[]>(HOSTEL_LEAVE_SECTIONS.map((section) => section.key));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "approve" | "reject">("");
  const [error, setError] = useState("");
  const { confirm, confirmDialog } = useConfirm();
  const data = detail.data;

  const toggle = useCallback((key: HostelLeaveSection) => {
    setSections((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));
  }, []);

  const approve = useCallback(async () => {
    if (!data) return;

    const confirmed = await confirm({
      actionLabel: "Approve and delete",
      description: `${sections.length} file${sections.length === 1 ? "" : "s"} go to ${data.request.ownerEmail ?? "the owner"} first. Then ${data.request.hostelName}${data.branches.length ? " and its branches" : ""} goes off the platform, its portal closes, and it is erased after ${data.request.holdDays} days unless the owner claims it back.`,
      pin: true,
      title: `Take ${data.request.hostelName} off the platform?`,
      tone: "destructive",
    });

    if (!confirmed) return;

    setBusy("approve");
    setError("");

    try {
      await browserApi(`/api/v1/platform/hostel-leaves/${data.request.id}/approve`, {
        body: JSON.stringify({ note: note.trim() || undefined, sections }),
        method: "POST",
      });
      await onDone(`${data.request.hostelName} is off the platform. Its data was emailed to the owner.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve.");
    } finally {
      setBusy("");
    }
  }, [confirm, data, note, onDone, sections]);

  const reject = useCallback(async () => {
    if (!data) return;

    if (note.trim().length < 3) {
      setError("Write a note — the owner is told why.");
      return;
    }

    setBusy("reject");
    setError("");

    try {
      await browserApi(`/api/v1/platform/hostel-leaves/${data.request.id}/reject`, {
        body: JSON.stringify({ note: note.trim() }),
        method: "POST",
      });
      await onDone("Not approved. The owner was told.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record that.");
    } finally {
      setBusy("");
    }
  }, [data, note, onDone]);

  const pending = data?.request.status === "PENDING";

  return (
    <>
    {confirmDialog}
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open={Boolean(requestId)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{data?.request.hostelName ?? "Leave request"}</DialogTitle>
          <DialogDescription>
            {data
              ? `${[data.request.ownerName, data.request.ownerEmail].filter(Boolean).join(" · ")} · on the platform since ${date(data.hostel.since)}`
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        <Message value={error || detail.message} />
        {detail.state === "loading" ? <LoadingRows /> : null}

        {data ? (
          <div className="space-y-4">
            <p className="text-[13.5px] text-foreground">“{data.request.reason}”</p>

            {data.blockers.length > 0 ? (
              <ul className="space-y-2">
                {data.blockers.map((blocker) => (
                  <li className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive" key={blocker.code}>
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    {blocker.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {data.branches.length > 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                Branches leaving too: {data.branches.map((branch) => branch.name).join(", ")}
              </p>
            ) : null}

            {pending ? (
              <>
                <fieldset className="space-y-2">
                  <div className="flex items-center justify-between">
                    <legend className="text-[12px] font-semibold text-foreground">Email to the owner (first day to today)</legend>
                    <button
                      className="text-[12px] font-semibold text-role-admin"
                      onClick={() =>
                        setSections(sections.length ? [] : HOSTEL_LEAVE_SECTIONS.map((section) => section.key))
                      }
                      type="button"
                    >
                      {sections.length ? "Untick all" : "Tick all"}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {HOSTEL_LEAVE_SECTIONS.map((section) => (
                      <label
                        className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[13px] text-foreground"
                        key={section.key}
                      >
                        <input
                          checked={sections.includes(section.key)}
                          className="size-4 accent-[var(--brand)]"
                          onChange={() => toggle(section.key)}
                          type="checkbox"
                        />
                        {section.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="block text-[12px] font-semibold text-foreground">
                  Note (needed to decline)
                  <textarea
                    className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] font-normal"
                    onChange={(event) => setNote(event.target.value)}
                    rows={2}
                    value={note}
                  />
                </label>

                <DialogFooter className="sm:justify-between">
                  <Button loading={busy === "reject"} disabled={Boolean(busy)} onClick={() => void reject()} type="button" variant="outline">
                    Decline
                  </Button>
                  <Button
                    disabled={Boolean(busy) || data.blockers.length > 0}
                    loading={busy === "approve"}
                    onClick={() => void approve()}
                    type="button"
                    variant="destructive"
                  >
                    Approve and delete
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">{STATUS_TEXT[data.request.status]}.</p>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
    </>
  );
}
