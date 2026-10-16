"use client";

import { Bell, Send } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
  StatusBadge,
  TextArea,
} from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { NotificationsPageContent } from "./notifications-page";
import { Message, PageHeader, field, optionalField } from "./portal-shared";

type Campaign = {
  audience: string;
  body: string;
  category: string;
  createdAt?: string;
  id: string;
  priority: string;
  recipientCount: number;
  scheduledFor?: string;
  sentAt?: string;
  stats: { delivered: number; read: number; sent: number };
  status: string;
  title: string;
};

type Resident = {
  fullName?: string;
  id: string;
  firstName: string;
  lastName: string;
  roomType?: string;
};

const CAMPAIGNS_ENDPOINT = "/api/v1/hostel-admin/notifications";

function shortDateTime(value?: string) {
  return value
    ? new Date(value).toLocaleString("en", {
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
      })
    : "—";
}

export const HostelAdminNotificationsPageContent = memo(
  function HostelAdminNotificationsPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [audience, setAudience] = useState("ALL");
    const [selectedResidents, setSelectedResidents] = useState<string[]>([]);
    const invalidate = useInvalidateResources();

    const campaignsResource = usePortalResource<{ campaigns: Campaign[] }>(
      CAMPAIGNS_ENDPOINT,
      { errorMessage: "Could not load notification campaigns." },
    );
    // Only fetched to populate the "specific residents" picker.
    const residentsResource = usePortalResource<{ residents: Resident[] }>(
      hostelAdminEndpoints.residents,
      { errorMessage: "" },
    );

    const campaigns = useMemo(
      () => campaignsResource.data?.campaigns ?? [],
      [campaignsResource.data],
    );
    const residents = residentsResource.data?.residents ?? [];

    const handleSubmit = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const scheduledFor = optionalField(form, "scheduledFor");

        setBusy(true);
        setActionMessage("");

        try {
          const result = await browserApi<{ campaign: Campaign }>(CAMPAIGNS_ENDPOINT, {
            body: JSON.stringify({
              audience,
              body: field(form, "body"),
              category: field(form, "category"),
              priority: field(form, "priority"),
              residentIds: audience === "SPECIFIC" ? selectedResidents : [],
              // A datetime-local value has no zone; the browser's own offset is
              // the right one — the admin picked a time in their day.
              scheduledFor: scheduledFor
                ? new Date(scheduledFor).toISOString()
                : undefined,
              title: field(form, "title"),
            }),
            method: "POST",
          });

          setActionMessage(
            result.campaign.status === "SCHEDULED"
              ? `Scheduled for ${shortDateTime(result.campaign.scheduledFor)}.`
              : `Sent to ${result.campaign.recipientCount} recipient(s).`,
          );
          formElement.reset();
          setAudience("ALL");
          setSelectedResidents([]);
          invalidate(CAMPAIGNS_ENDPOINT);
          await campaignsResource.refreshAsync();
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not send the notification.",
          );
        } finally {
          setBusy(false);
        }
      },
      [audience, campaignsResource, invalidate, selectedResidents],
    );

    return (
      <div className="mx-auto max-w-[1100px] space-y-6">
        <PageHeader
          description="Send, schedule and track notices to residents."
          icon={Bell}
          title="Notifications"
        />
        <Message value={actionMessage} />

        <Panel title="Compose">
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Title" name="title" required />
              <Input
                defaultValue="ANNOUNCEMENT"
                hint="Groups the notification in the resident's feed."
                label="Category"
                name="category"
                required
              />
            </div>
            <TextArea label="Message" name="body" />
            <div className="grid gap-4 sm:grid-cols-3">
              <Select defaultValue="NORMAL" label="Priority" name="priority">
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </Select>
              <Select
                label="Audience"
                name="audience"
                onChange={(event) => setAudience(event.target.value)}
                value={audience}
              >
                <option value="ALL">All residents</option>
                <option value="GUARDIANS">Linked guardians</option>
                <option value="SPECIFIC">Specific residents</option>
              </Select>
              <Input
                hint="Leave empty to send immediately."
                label="Schedule for"
                name="scheduledFor"
                type="datetime-local"
              />
            </div>

            {audience === "SPECIFIC" ? (
              <fieldset className="rounded-lg border border-border p-3">
                <legend className="px-1 text-xs font-semibold text-muted-foreground">
                  Recipients ({selectedResidents.length} selected)
                </legend>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {residents.length === 0 ? (
                    <p className="p-2 text-sm text-muted-foreground">
                      No active residents to pick from.
                    </p>
                  ) : (
                    residents.map((resident) => (
                      <label
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                        key={resident.id}
                      >
                        <input
                          checked={selectedResidents.includes(resident.id)}
                          onChange={(event) =>
                            setSelectedResidents((current) =>
                              event.target.checked
                                ? [...current, resident.id]
                                : current.filter((id) => id !== resident.id),
                            )
                          }
                          type="checkbox"
                        />
                        <span>
                          {resident.fullName ??
                            `${resident.firstName} ${resident.lastName}`.trim()}
                        </span>
                        {resident.roomType ? (
                          <span className="text-xs text-muted-foreground">
                            {resident.roomType}
                          </span>
                        ) : null}
                      </label>
                    ))
                  )}
                </div>
              </fieldset>
            ) : null}

            <div className="flex justify-end">
              <button
                className="inline-flex items-center gap-2 rounded-md bg-role-admin px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-admin disabled:opacity-60"
                disabled={busy}
                type="submit"
              >
                <Send aria-hidden="true" className="size-4" />
                {busy ? "Sending…" : "Send notification"}
              </button>
            </div>
          </form>
        </Panel>

        <Panel title="Sent & scheduled">
          {campaignsResource.state === "loading" ? <LoadingRows /> : null}
          {campaignsResource.state === "error" ? (
            <EmptyState label="Campaigns could not be loaded." />
          ) : null}
          {campaignsResource.state !== "loading" && campaigns.length === 0 ? (
            <EmptyState label="Nothing sent yet. Compose your first notification above." />
          ) : null}

          <div className="space-y-3">
            {campaigns.map((campaign) => (
              <div className="rounded-lg border border-border p-4" key={campaign.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{campaign.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{campaign.body}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {campaign.category} · {campaign.audience} ·{" "}
                      {campaign.status === "SCHEDULED"
                        ? `scheduled ${shortDateTime(campaign.scheduledFor)}`
                        : `sent ${shortDateTime(campaign.sentAt)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <StatusBadge>{campaign.priority}</StatusBadge>
                    <StatusBadge>{campaign.status}</StatusBadge>
                  </div>
                </div>
                {/* Read counts come from the receipts themselves, so they stay
                    right even if a campaign is re-read months later. */}
                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <div className="flex gap-1.5">
                    <dt>Sent</dt>
                    <dd className="font-semibold text-foreground">
                      {campaign.stats.sent}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>Delivered</dt>
                    <dd className="font-semibold text-foreground">
                      {campaign.stats.delivered}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>Read</dt>
                    <dd className="font-semibold text-foreground">
                      {campaign.stats.read}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </Panel>

        <NotificationsPageContent />
      </div>
    );
  },
);
