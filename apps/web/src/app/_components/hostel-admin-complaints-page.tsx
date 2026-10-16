"use client";

import { AlertTriangle, CheckCircle2, Clock, Inbox, MessageSquareWarning, Wrench } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, LoadingRows, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";

import {
  field,
  optionalField,
  PageHeader,
  type Complaint,
  type ComplaintSummary,
} from "./hostel-admin-shared";
import { MetricCard } from "./portal-dashboard-ui";

const EMPTY_SUMMARY: ComplaintSummary = {
  inProgress: 0,
  overdue: 0,
  pending: 0,
  rejected: 0,
  resolved: 0,
  total: 0,
};

export const HostelAdminComplaintsPage = memo(function HostelAdminComplaintsPage() {
  const [categoryFilter, setCategoryFilter] = useState("");
  const [filter, setFilter] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const invalidate = useInvalidateResources();

  // Each filter combination is its own cache entry, so flipping back to a
  // filter already viewed paints from cache instead of re-fetching blind.
  const complaintsResource = usePortalResource<{
    complaints: Complaint[];
    summary: ComplaintSummary;
  }>(hostelAdminEndpoints.complaints({ category: categoryFilter, status: filter }), {
    errorMessage: "Could not load complaints.",
  });

  const complaints = useMemo(
    () => complaintsResource.data?.complaints ?? [],
    [complaintsResource.data],
  );
  const summary = complaintsResource.data?.summary ?? EMPTY_SUMMARY;
  const state = complaintsResource.state;
  const message = actionMessage || complaintsResource.message;

  const handleReply = useCallback(
    async (event: FormEvent<HTMLFormElement>, complaintId: string) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const reply = field(form, "message");

      if (!reply) {
        setActionMessage("Reply message is required.");
        return;
      }

      try {
        await browserApi(`${hostelAdminEndpoints.complaints()}/${complaintId}/reply`, {
          body: JSON.stringify({ message: reply }),
          method: "POST",
        });
        formElement.reset();
        setActionMessage("Reply saved.");
        invalidate(hostelAdminEndpoints.complaintsAll);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not save reply.",
        );
      }
    },
    [invalidate],
  );

  const handleStatus = useCallback(
    async (event: FormEvent<HTMLFormElement>, complaintId: string) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      try {
        await browserApi(`${hostelAdminEndpoints.complaints()}/${complaintId}/status`, {
          body: JSON.stringify({
            response: optionalField(form, "response"),
            status: field(form, "status"),
          }),
          method: "PATCH",
        });
        setActionMessage("Complaint status updated.");
        invalidate(
          hostelAdminEndpoints.complaintsAll,
          hostelAdminEndpoints.complaintsReport,
        );
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not update status.",
        );
      }
    },
    [invalidate],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PageHeader
        action={
          <div className="flex flex-wrap gap-2">
            <select
              className="h-11 rounded-md border border-border bg-background px-3 text-sm"
              onChange={(event) => setFilter(event.target.value)}
              value={filter}
            >
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="RESOLVED">Resolved</option>
              <option value="REJECTED">Rejected</option>
            </select>
            <select
              className="h-11 rounded-md border border-border bg-background px-3 text-sm"
              onChange={(event) => setCategoryFilter(event.target.value)}
              value={categoryFilter}
            >
              <option value="">All categories</option>
              {[
                "FOOD",
                "ROOM",
                "MAINTENANCE",
                "SAFETY",
                "PAYMENT",
                "STAFF",
                "NOISE",
                "OTHER",
              ].map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        }
        description="Triage resident issues, reply privately, and track SLA pressure."
        icon={MessageSquareWarning}
        title="Complaints"
      />

      {message ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {message}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-5">
        <MetricCard icon={Inbox} label="Total" value={summary.total} />
        <MetricCard icon={Clock} label="Pending" tone="amber" value={summary.pending} />
        <MetricCard icon={Wrench} label="In progress" value={summary.inProgress} />
        <MetricCard icon={AlertTriangle} label="Overdue" tone="rose" value={summary.overdue} />
        <MetricCard icon={CheckCircle2} label="Resolved" value={summary.resolved} />
      </div>

      <Panel title="Complaint Queue">
        {state === "loading" ? <LoadingRows /> : null}
        {state === "error" ? (
          <EmptyState label="Complaints could not be loaded." />
        ) : null}
        {state === "ready" && complaints.length === 0 ? (
          <EmptyState label="No complaints in this queue." />
        ) : null}
        <div className="grid gap-4 xl:grid-cols-2">
          {complaints.map((complaint) => (
            <div className="rounded-lg border border-border p-4" key={complaint.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-foreground">{complaint.title}</p>
                  {complaint.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {complaint.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge>{complaint.status}</StatusBadge>
                  <StatusBadge>{complaint.category}</StatusBadge>
                  {complaint.isOverdue ? <StatusBadge>OVERDUE</StatusBadge> : null}
                </div>
              </div>

              {/*
                A complaint raised from the app can have no typed description at
                all — the resident held the microphone and said what was wrong.
                Without this the queue row for it is a title and nothing else.

                A plain `<audio>` pointed at the authorizing route: this browser
                is cookie-authenticated, so the 302 to the presigned R2 URL is
                followed with no header of ours attached. That is the whole
                reason the mobile player needs `?format=json` and this does not.
              */}
              {complaint.voiceNoteAssetId ? (
                <audio
                  className="mt-3 w-full"
                  controls
                  preload="none"
                  src={`/api/v1/files/${complaint.voiceNoteAssetId}/url`}
                >
                  Your browser cannot play this recording.
                </audio>
              ) : null}

              <div className="mt-4 grid gap-2 text-sm text-muted-foreground md:grid-cols-3">
                <span>
                  Resident: {complaint.isAnonymous ? "Anonymous" : complaint.residentId}
                </span>
                <span>SLA: {new Date(complaint.slaDueAt).toLocaleString()}</span>
                <span className="flex flex-wrap items-center gap-2">
                  Photos:{" "}
                  {complaint.attachments.length > 0 ? (
                    complaint.attachments.map((item) => (
                      /*
                       * The thumbnail variant, which the route serves when one
                       * exists and silently falls back to the original when it
                       * does not. This row used to print the raw asset ids,
                       * which told an admin a photograph existed and gave them
                       * no way at all to look at it.
                       */
                      <a
                        className="inline-block"
                        href={`/api/v1/files/${item.fileAssetId}/url`}
                        key={item.id}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- private asset served through our own authorizing route */}
                        <img
                          alt="Complaint photo"
                          className="h-12 w-12 rounded-md border border-border object-cover"
                          src={`/api/v1/files/${item.fileAssetId}/url?variant=THUMBNAIL`}
                        />
                      </a>
                    ))
                  ) : (
                    <>None</>
                  )}
                </span>
              </div>

              {complaint.adminResponse ? (
                <div className="mt-4 rounded-md bg-muted p-3 text-sm text-foreground">
                  {complaint.adminResponse}
                </div>
              ) : null}

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <BusyForm
                  className="grid gap-2"
                  onSubmit={(event) => handleReply(event, complaint.id)}
                >
                  <textarea
                    className="min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-role-admin"
                    name="message"
                    placeholder="Reply to resident"
                  />
                  <SubmitButton className="h-10 rounded-md border border-role-admin px-3 text-sm font-semibold text-role-admin">
                    Save Reply
                  </SubmitButton>
                </BusyForm>
                <BusyForm
                  className="grid gap-2"
                  onSubmit={(event) => handleStatus(event, complaint.id)}
                >
                  <select
                    className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                    defaultValue={complaint.status}
                    name="status"
                  >
                    <option value="PENDING">Pending</option>
                    <option value="IN_PROGRESS">In progress</option>
                    <option value="RESOLVED">Resolved</option>
                    <option value="REJECTED">Rejected</option>
                  </select>
                  <textarea
                    className="min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-role-admin"
                    name="response"
                    placeholder="Optional response"
                  />
                  <SubmitButton className="h-10 rounded-md bg-role-admin px-3 text-sm font-semibold text-white">
                    Update Status
                  </SubmitButton>
                </BusyForm>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
});
