"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

import { CalendarCheck, CheckCircle2, Inbox, Pencil, Phone } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { Chip } from "@/app/_components/hostel-admin-page-ui";
import { InitialsAvatar, MetricCard, SearchField } from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { field, Inquiry, Message, PageHeader } from "./core-portal-shared";

const STATUSES = ["NEW", "CONTACTED", "VISIT_SCHEDULED", "CONVERTED", "CLOSED"] as const;

type StatusFilter = "ALL" | (typeof STATUSES)[number];

export const HostelAdminInquiriesPageContent = memo(
  function HostelAdminInquiriesPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
    const [editingId, setEditingId] = useState<string | null>(null);
    const invalidate = useInvalidateResources();
    const inquiriesResource = usePortalResource<{ inquiries: Inquiry[] }>(
      hostelAdminEndpoints.inquiries,
      { errorMessage: "Could not load inquiries." },
    );

    const inquiries = useMemo(
      () => inquiriesResource.data?.inquiries ?? [],
      [inquiriesResource.data],
    );
    const message = actionMessage || inquiriesResource.message;

    const shown = useMemo(() => {
      const query = search.trim().toLowerCase();

      return inquiries.filter(
        (inquiry) =>
          (statusFilter === "ALL" || inquiry.status === statusFilter) &&
          (!query ||
            [inquiry.name, inquiry.phone, inquiry.email, inquiry.preferredRoomType]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(query)),
      );
    }, [inquiries, search, statusFilter]);

    const count = (status: string) => inquiries.filter((inquiry) => inquiry.status === status).length;
    const editing = inquiries.find((inquiry) => inquiry.id === editingId) ?? null;

    /** `true` when the server took it. */
    const updateStatus = useCallback(
      async (event: FormEvent<HTMLFormElement>, inquiryId: string) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);

        try {
          await browserApi(`${hostelAdminEndpoints.inquiries}/${inquiryId}/status`, {
            body: JSON.stringify({ status: field(form, "status") }),
            method: "PATCH",
          });
          invalidate(hostelAdminEndpoints.inquiries);
          return true;
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update inquiry.",
          );
          return false;
        }
      },
      [invalidate],
    );

    const addNote = useCallback(
      async (event: FormEvent<HTMLFormElement>, inquiryId: string) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);

        try {
          await browserApi(`${hostelAdminEndpoints.inquiries}/${inquiryId}/notes`, {
            body: JSON.stringify({ note: field(form, "note") }),
            method: "POST",
          });
          formElement.reset();
          invalidate(hostelAdminEndpoints.inquiries);
          return true;
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not add note.",
          );
          return false;
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          description="People who asked about a room, and where each one stands."
          icon={Inbox}
          title="Inquiries"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Inbox} label="New" tone={count("NEW") > 0 ? "amber" : "teal"} value={count("NEW")} />
          <MetricCard
            icon={CalendarCheck}
            label="Contacted or visiting"
            value={count("CONTACTED") + count("VISIT_SCHEDULED")}
          />
          <MetricCard icon={CheckCircle2} label="Moved in" value={count("CONVERTED")} />
        </div>

        <Panel>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <SearchField onChange={setSearch} placeholder="Search name, phone, room…" size="lg" value={search} />
            <FilterButton active={statusFilter === "ALL" ? 0 : 1} onClear={() => setStatusFilter("ALL")}>
              <FilterChoice
                label="Status"
                onChange={setStatusFilter}
                options={[
                  { label: "All", value: "ALL" },
                  ...STATUSES.map((status) => ({ label: status.replaceAll("_", " ").toLowerCase(), value: status })),
                ]}
                value={statusFilter}
              />
            </FilterButton>
            <span className="text-[12.5px] font-medium text-muted-foreground">{shown.length} inquiries</span>
          </div>

          {shown.length === 0 ? (
            <EmptyState label={inquiries.length === 0 ? "No inquiries yet." : "Nothing matches."} />
          ) : null}
          <div className="grid gap-3 xl:grid-cols-2">
            {shown.map((inquiry) => (
              <article
                className="space-y-3 rounded-2xl border border-border/70 p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                key={inquiry.id}
              >
                <div className="flex items-start gap-3">
                  <InitialsAvatar name={inquiry.name} size="sm" tone="admin" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold text-foreground">{inquiry.name}</p>
                    <p className="flex items-center gap-1.5 truncate text-[12.5px] text-muted-foreground">
                      <Phone className="size-3.5 shrink-0" />
                      {[inquiry.phone, inquiry.email].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <StatusBadge>{inquiry.status}</StatusBadge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {inquiry.preferredRoomType ? <Chip glyph="bed">{inquiry.preferredRoomType}</Chip> : null}
                  {inquiry.budgetRange ? <Chip glyph="cash">{inquiry.budgetRange}</Chip> : null}
                  {inquiry.gender ? <Chip glyph="person">{inquiry.gender}</Chip> : null}
                  {inquiry.preferredVisitDate ? (
                    <Chip glyph="calendar" tone="brand">
                      {`Visit ${formatHostelDate(inquiry.preferredVisitDate)}`}
                    </Chip>
                  ) : null}
                </div>
                {inquiry.message ? (
                  <p className="line-clamp-3 text-[13.5px] text-foreground">{inquiry.message}</p>
                ) : null}
                <Button onClick={() => setEditingId(inquiry.id)} size="sm" type="button" variant="outline">
                  <Pencil className="size-3.5" />
                  Update
                </Button>
              </article>
            ))}
          </div>
        </Panel>

        <Dialog onOpenChange={(open) => (open ? null : setEditingId(null))} open={editing !== null}>
          <DialogContent className="sm:max-w-md">
            {editing ? (
              <>
                <DialogHeader>
                  <DialogTitle>{editing.name}</DialogTitle>
                  <DialogDescription>Move the inquiry along, or note a follow-up.</DialogDescription>
                </DialogHeader>
                <BusyForm
                  className="flex gap-2"
                  key={editing.id}
                  onSubmit={async (event) => {
                    if (await updateStatus(event, editing.id)) setEditingId(null);
                  }}
                >
                  <select
                    aria-label="Status"
                    className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-[13.5px]"
                    defaultValue={editing.status}
                    name="status"
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                  <SubmitButton className="h-10 rounded-xl bg-brand-teal px-4 text-white hover:bg-brand-teal/90">
                    Save
                  </SubmitButton>
                </BusyForm>
                <BusyForm
                  className="flex gap-2"
                  onSubmit={async (event) => {
                    if (await addNote(event, editing.id)) setEditingId(null);
                  }}
                >
                  <input
                    aria-label="Follow-up note"
                    className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-[13.5px]"
                    name="note"
                    placeholder="Follow-up note"
                    required
                  />
                  <SubmitButton className="h-10 rounded-xl px-4" variant="outline">
                    Add note
                  </SubmitButton>
                </BusyForm>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);
