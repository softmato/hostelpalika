"use client";

import { AlarmClock, CheckCircle2, MessageSquareWarning, Plus, Send } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Input, Select, TextArea } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Glyph, type GlyphName } from "@/components/glyph";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileUploaderView, useUploader } from "@/components/uploads";
import { browserApi } from "@/lib/browser-api";
import { dayMonthYear } from "@/lib/format-month";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { cn } from "@/lib/utils";
import { CardSkeletons, FactChip, SectionTitle, titleCase } from "./daily-portal-ui";
import { EmptyInline, MetricCard, RoleButton } from "./portal-dashboard-ui";
import { type Complaint, ResidentHeader, Message, field } from "./resident-shared";

const CATEGORY_GLYPH: Record<string, GlyphName> = {
  FOOD: "restaurant",
  MAINTENANCE: "build",
  NOISE: "volume-high",
  OTHER: "chatbubble",
  PAYMENT: "card",
  ROOM: "bed",
  SAFETY: "shield",
  STAFF: "people",
};

/* Complaint status → colour, per DESIGN.md: resolved green, in progress amber,
   rejected rose, pending grey. */
const STATUS_CHIP: Record<Complaint["status"], string> = {
  IN_PROGRESS: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  PENDING: "bg-muted text-muted-foreground",
  REJECTED: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  RESOLVED: "bg-role-team-soft text-role-team",
};

type StatusFilter = "ALL" | "OPEN" | "RESOLVED" | "REJECTED";

export const ResidentComplaintsPageContent = memo(
  function ResidentComplaintsPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [creating, setCreating] = useState(false);
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
    // Evidence photos/documents for the complaint. Progress shows in the global
    // toaster; the form only needs the resulting asset ids.
    const attachments = useUploader({
      accessLevel: "PRIVATE",
      kind: "document",
      label: "Attachment",
      maxFiles: 5,
      optimizeImage: true,
    });
    const { clear: clearAttachments, files: attachmentFiles } = attachments;
    const invalidate = useInvalidateResources();
    const complaintsResource = usePortalResource<{ complaints: Complaint[] }>(
      residentEndpoints.complaints,
      { errorMessage: "Could not load complaints." },
    );

    const complaints = useMemo(
      () => complaintsResource.data?.complaints ?? [],
      [complaintsResource.data],
    );
    const state = complaintsResource.state;
    const message = actionMessage || complaintsResource.message;

    const counts = useMemo(
      () => ({
        open: complaints.filter((item) => item.status === "PENDING" || item.status === "IN_PROGRESS").length,
        overdue: complaints.filter((item) => item.isOverdue).length,
        resolved: complaints.filter((item) => item.status === "RESOLVED").length,
      }),
      [complaints],
    );

    const visible = useMemo(() => {
      if (statusFilter === "OPEN") {
        return complaints.filter((item) => item.status === "PENDING" || item.status === "IN_PROGRESS");
      }

      return statusFilter === "ALL" ? complaints : complaints.filter((item) => item.status === statusFilter);
    }, [complaints, statusFilter]);

    const handleCreateComplaint = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);

        try {
          await browserApi(residentEndpoints.complaints, {
            body: JSON.stringify({
              attachmentAssetIds: attachmentFiles
                .map((file) => file.assetId)
                .filter((assetId): assetId is string => Boolean(assetId)),
              category: field(form, "category"),
              description: field(form, "description"),
              isAnonymous: form.get("isAnonymous") === "on",
              title: field(form, "title"),
            }),
            method: "POST",
          });
          formElement.reset();
          clearAttachments();
          setCreating(false);
          setActionMessage("Complaint submitted.");
          invalidate(residentEndpoints.complaints, residentEndpoints.dashboard);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not submit complaint.",
          );
        }
      },
      [attachmentFiles, clearAttachments, invalidate],
    );

    const confirmResolution = useCallback(
      async (complaintId: string) => {
        const note = window.prompt("Optional confirmation note")?.trim();

        try {
          await browserApi(
            `${residentEndpoints.complaints}/${complaintId}/confirm-resolution`,
            {
              body: JSON.stringify(note ? { note } : {}),
              method: "PATCH",
            },
          );
          setActionMessage("Resolution confirmed.");
          invalidate(residentEndpoints.complaints, residentEndpoints.dashboard);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not confirm resolution.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1100px] space-y-5">
        <ResidentHeader
          actions={
            <RoleButton className="h-9 px-4" onClick={() => setCreating(true)} tone="team">
              <Plus className="size-4" />
              New complaint
            </RoleButton>
          }
          description="Report a problem and follow it to the end."
          icon={MessageSquareWarning}
          title="Complaints"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={MessageSquareWarning} label="Open" value={counts.open} />
          <MetricCard icon={CheckCircle2} label="Resolved" value={counts.resolved} />
          <MetricCard
            icon={AlarmClock}
            label="Past due"
            tone={counts.overdue > 0 ? "rose" : "teal"}
            value={counts.overdue}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <SectionTitle>My complaints</SectionTitle>
          <FilterButton active={statusFilter === "ALL" ? 0 : 1} onClear={() => setStatusFilter("ALL")}>
            <FilterChoice
              label="Status"
              onChange={setStatusFilter}
              options={[
                { label: "All", value: "ALL" },
                { label: "Open", value: "OPEN" },
                { label: "Resolved", value: "RESOLVED" },
                { label: "Rejected", value: "REJECTED" },
              ]}
              value={statusFilter}
            />
          </FilterButton>
        </div>

        {state === "loading" ? <CardSkeletons count={2} /> : null}
        {state === "error" ? <EmptyState label="Complaints could not be loaded." /> : null}
        {state === "ready" && visible.length === 0 ? (
          <EmptyInline label={complaints.length === 0 ? "No complaints yet." : "None in this filter."} />
        ) : null}

        <div className="grid gap-3">
          {visible.map((complaint) => (
            <article className="rounded-2xl border border-border/70 bg-card p-4" key={complaint.id}>
              <div className="flex gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                  <Glyph className="size-5" name={CATEGORY_GLYPH[complaint.category] ?? "chatbubble"} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-heading text-[15px] font-semibold text-foreground">{complaint.title}</p>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
                        STATUS_CHIP[complaint.status],
                      )}
                    >
                      {titleCase(complaint.status)}
                    </span>
                  </div>
                  {complaint.description ? (
                    <p className="mt-0.5 line-clamp-3 text-[13.5px] text-muted-foreground">{complaint.description}</p>
                  ) : null}
                  {/*
                    Their own recording, when they raised it from the app by
                    speaking. Cookie-authenticated, so a plain `<audio>` pointed
                    at the authorizing route follows the 302 to storage with no
                    header of ours attached.
                  */}
                  {complaint.voiceNoteAssetId ? (
                    <audio
                      className="mt-2 w-full"
                      controls
                      preload="none"
                      src={`/api/v1/files/${complaint.voiceNoteAssetId}/url`}
                    >
                      Your browser cannot play this recording.
                    </audio>
                  ) : null}
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <FactChip glyph="pricetag">{titleCase(complaint.category)}</FactChip>
                    {complaint.createdAt ? (
                      <FactChip glyph="calendar">{dayMonthYear(complaint.createdAt)}</FactChip>
                    ) : null}
                    <FactChip glyph="time" tone={complaint.isOverdue ? "wrong" : "neutral"}>
                      {`Answer by ${dayMonthYear(complaint.slaDueAt)}`}
                    </FactChip>
                    {complaint.attachments.length > 0 ? (
                      <FactChip glyph="attach">{`${complaint.attachments.length} attached`}</FactChip>
                    ) : null}
                    {complaint.isAnonymous ? <FactChip glyph="eye-off">Anonymous</FactChip> : null}
                  </div>
                  {complaint.adminResponse ? (
                    <div className="mt-3 flex gap-2 rounded-xl bg-muted/60 p-3 text-[13.5px] text-foreground">
                      <Glyph className="mt-0.5 size-4 shrink-0 text-muted-foreground" name="chatbubble-ellipses" />
                      {complaint.adminResponse}
                    </div>
                  ) : null}
                  {complaint.status === "RESOLVED" && !complaint.confirmedAt ? (
                    <RoleButton
                      className="mt-3"
                      onClick={() => void confirmResolution(complaint.id)}
                      tone="team"
                    >
                      <CheckCircle2 className="size-4" />
                      Confirm it is fixed
                    </RoleButton>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>

        <Dialog onOpenChange={setCreating} open={creating}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>New complaint</DialogTitle>
              <DialogDescription>Your hostel has to answer by its deadline.</DialogDescription>
            </DialogHeader>
            <BusyForm className="grid gap-3" onSubmit={handleCreateComplaint}>
              <Input label="Title" name="title" required />
              <Select label="Category" name="category" required>
                {["FOOD", "ROOM", "MAINTENANCE", "SAFETY", "PAYMENT", "STAFF", "NOISE", "OTHER"].map((category) => (
                  <option key={category} value={category}>
                    {titleCase(category)}
                  </option>
                ))}
              </Select>
              <TextArea label="What happened" name="description" />
              <FileUploaderView label="Add a photo or document" tone="resident" uploader={attachments} />
              <label className="flex items-center gap-2 text-[13px] text-foreground">
                <input className="accent-brand-teal" name="isAnonymous" type="checkbox" />
                Send without my name
              </label>
              <DialogFooter>
                <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">
                  <Send className="size-4" />
                  Submit
                </SubmitButton>
              </DialogFooter>
            </BusyForm>
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);
