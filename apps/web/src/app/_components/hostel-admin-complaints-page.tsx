"use client";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { AlertTriangle, CheckCircle2, Clock, Inbox, MessageSquareWarning, Pencil, Wrench } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { Chip, RowMark, ShareBar, type ChipTone } from "@/app/_components/hostel-admin-page-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { MetricCard, SearchField } from "./portal-dashboard-ui";

const STATUSES = ["PENDING", "IN_PROGRESS", "RESOLVED", "REJECTED"] as const;

const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  IN_PROGRESS: "In progress",
  PENDING: "Pending",
  REJECTED: "Rejected",
  RESOLVED: "Resolved",
};

/** docs/DESIGN.md: resolved green, in progress amber, rejected red, pending grey. */
const STATUS_TONE: Record<string, ChipTone> = {
  IN_PROGRESS: "warn",
  PENDING: "neutral",
  REJECTED: "bad",
  RESOLVED: "brand",
};

const CATEGORIES = ["FOOD", "ROOM", "MAINTENANCE", "SAFETY", "PAYMENT", "STAFF", "NOISE", "OTHER"];

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

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
  const [search, setSearch] = useState("");
  const [respondingId, setRespondingId] = useState<string | null>(null);
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

  const shown = useMemo(() => {
    const query = search.trim().toLowerCase();

    return query
      ? complaints.filter((complaint) =>
          `${complaint.title} ${complaint.description ?? ""}`.toLowerCase().includes(query),
        )
      : complaints;
  }, [complaints, search]);
  const responding = complaints.find((complaint) => complaint.id === respondingId) ?? null;

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PageHeader
        description="Resident issues, your replies, and what is past its deadline."
        icon={MessageSquareWarning}
        title="Complaints"
      />

      {message && !responding ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13.5px]">
          {message}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard icon={Inbox} label="Total" value={summary.total} />
        <MetricCard icon={Clock} label="Pending" tone="slate" value={summary.pending} />
        <MetricCard icon={Wrench} label="In progress" tone="amber" value={summary.inProgress} />
        <MetricCard icon={AlertTriangle} label="Overdue" tone={summary.overdue > 0 ? "rose" : "slate"} value={summary.overdue} />
        <MetricCard icon={CheckCircle2} label="Resolved" value={summary.resolved} />
      </div>

      {summary.total > 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card px-4 py-3">
          <ShareBar label="resolved" total={summary.total} value={summary.resolved} />
        </div>
      ) : null}

      <Panel title="Queue">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchField onChange={setSearch} placeholder="Search complaints" size="lg" value={search} />
          <FilterButton
            active={(filter ? 1 : 0) + (categoryFilter ? 1 : 0)}
            onClear={() => {
              setFilter("");
              setCategoryFilter("");
            }}
          >
            <FilterChoice
              label="Status"
              onChange={setFilter}
              options={[
                { label: "All", value: "" },
                ...STATUSES.map((status) => ({ label: STATUS_LABEL[status], value: status })),
              ]}
              value={filter}
            />
            <FilterChoice
              label="Category"
              onChange={setCategoryFilter}
              options={[
                { label: "All", value: "" },
                ...CATEGORIES.map((category) => ({ label: titleCase(category), value: category })),
              ]}
              value={categoryFilter}
            />
          </FilterButton>
          <span className="text-[12.5px] font-medium text-muted-foreground">{shown.length} shown</span>
        </div>

        {state === "loading" ? <LoadingRows /> : null}
        {state === "error" ? (
          <EmptyState label="Complaints could not be loaded." />
        ) : null}
        {state === "ready" && shown.length === 0 ? (
          <EmptyState label="No complaints in this queue." />
        ) : null}
        <div className="grid gap-3 xl:grid-cols-2">
          {shown.map((complaint) => (
            <article
              className="space-y-3 rounded-2xl border border-border/70 p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
              key={complaint.id}
            >
              <div className="flex items-start gap-3">
                <RowMark
                  glyph={complaint.isOverdue ? "alarm" : "chatbox-alert"}
                  tone={complaint.isOverdue ? "bad" : "brand"}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-foreground">{complaint.title}</p>
                  {complaint.description ? (
                    <p className="mt-0.5 line-clamp-3 text-[13px] text-muted-foreground">
                      {complaint.description}
                    </p>
                  ) : null}
                </div>
                <Chip tone={STATUS_TONE[complaint.status] ?? "neutral"}>
                  {STATUS_LABEL[complaint.status as (typeof STATUSES)[number]] ?? complaint.status}
                </Chip>
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
                  className="w-full"
                  controls
                  preload="none"
                  src={`/api/v1/files/${complaint.voiceNoteAssetId}/url`}
                >
                  Your browser cannot play this recording.
                </audio>
              ) : null}

              <div className="flex flex-wrap gap-1.5">
                <Chip glyph="pricetag">{titleCase(complaint.category)}</Chip>
                <Chip glyph="person">{complaint.isAnonymous ? "Anonymous" : complaint.residentId}</Chip>
                <Chip glyph="alarm" tone={complaint.isOverdue ? "bad" : "neutral"}>
                  {`${complaint.isOverdue ? "Overdue · " : "Due "}${formatHostelDateTime(complaint.slaDueAt)}`}
                </Chip>
              </div>

              {complaint.attachments.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {complaint.attachments.map((item) => (
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
                        className="size-14 rounded-xl border border-border object-cover"
                        src={`/api/v1/files/${item.fileAssetId}/url?variant=THUMBNAIL`}
                      />
                    </a>
                  ))}
                </div>
              ) : null}

              {complaint.adminResponse ? (
                <div className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] text-foreground">
                  {complaint.adminResponse}
                </div>
              ) : null}

              <Button onClick={() => setRespondingId(complaint.id)} size="sm" type="button" variant="outline">
                <Pencil className="size-3.5" />
                Respond
              </Button>
            </article>
          ))}
        </div>
      </Panel>

      <Dialog onOpenChange={(open) => (open ? null : setRespondingId(null))} open={responding !== null}>
        <DialogContent className="sm:max-w-lg">
          {responding ? (
            <>
              <DialogHeader>
                <DialogTitle>{responding.title}</DialogTitle>
                <DialogDescription>Reply privately, or move it along with a note.</DialogDescription>
              </DialogHeader>
              {message ? <p className="text-[12.5px] text-muted-foreground">{message}</p> : null}
              <BusyForm
                className="grid gap-2"
                key={`reply-${responding.id}`}
                onSubmit={(event) => handleReply(event, responding.id)}
              >
                <textarea
                  className="min-h-20 rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] outline-none focus:border-brand-teal"
                  name="message"
                  placeholder="Reply to resident"
                />
                <SubmitButton className="h-10 rounded-xl" variant="outline">
                  Save reply
                </SubmitButton>
              </BusyForm>
              <BusyForm
                className="grid gap-2 border-t border-border/60 pt-4"
                key={`status-${responding.id}`}
                onSubmit={(event) => handleStatus(event, responding.id)}
              >
                <select
                  aria-label="Status"
                  className="h-10 rounded-xl border border-border bg-background px-3 text-[13.5px]"
                  defaultValue={responding.status}
                  name="status"
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
                <textarea
                  className="min-h-20 rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] outline-none focus:border-brand-teal"
                  name="response"
                  placeholder="Optional response"
                />
                <SubmitButton className="h-10 rounded-xl bg-brand-teal text-white hover:bg-brand-teal/90">
                  Update status
                </SubmitButton>
              </BusyForm>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
});
