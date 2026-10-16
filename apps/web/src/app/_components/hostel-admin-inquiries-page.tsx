"use client";

import { Inbox } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { field, Inquiry, Message, PageHeader } from "./core-portal-shared";

export const HostelAdminInquiriesPageContent = memo(
  function HostelAdminInquiriesPageContent() {
    const [actionMessage, setActionMessage] = useState("");
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
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update inquiry.",
          );
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
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not add note.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PageHeader
          description="Public inquiries stored against this hostel with room preference and budget."
          icon={Inbox}
          title="Inquiries"
        />
        <Message value={message} />
        <Panel>
          {inquiries.length === 0 ? <EmptyState label="No inquiries yet." /> : null}
          <div className="grid gap-4 xl:grid-cols-2">
            {inquiries.map((inquiry) => (
              <div className="rounded-lg border border-border p-4" key={inquiry.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground">{inquiry.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {inquiry.phone} {inquiry.email}
                    </p>
                  </div>
                  <StatusBadge>{inquiry.status}</StatusBadge>
                </div>
                <div className="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                  <span>Room: {inquiry.preferredRoomType || "-"}</span>
                  <span>Budget: {inquiry.budgetRange || "-"}</span>
                  <span>Gender: {inquiry.gender || "-"}</span>
                  <span>
                    Visit:{" "}
                    {inquiry.preferredVisitDate
                      ? new Date(inquiry.preferredVisitDate).toLocaleDateString()
                      : "-"}
                  </span>
                </div>
                <p className="mt-3 text-sm text-foreground">{inquiry.message}</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <BusyForm
                    className="flex gap-2"
                    onSubmit={(event) => updateStatus(event, inquiry.id)}
                  >
                    <select
                      className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                      defaultValue={inquiry.status}
                      name="status"
                    >
                      {["NEW", "CONTACTED", "VISIT_SCHEDULED", "CONVERTED", "CLOSED"].map(
                        (status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ),
                      )}
                    </select>
                    <SubmitButton className="rounded-md bg-role-admin px-3 text-sm font-semibold text-white">
                      Save
                    </SubmitButton>
                  </BusyForm>
                  <BusyForm
                    className="flex gap-2"
                    onSubmit={(event) => addNote(event, inquiry.id)}
                  >
                    <input
                      aria-label="Follow-up note"
                      className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                      name="note"
                      placeholder="Follow-up note"
                      required
                    />
                    <SubmitButton className="rounded-md border border-role-admin px-3 text-sm font-semibold text-role-admin">
                      Note
                    </SubmitButton>
                  </BusyForm>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    );
  },
);
