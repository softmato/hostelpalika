"use client";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { Bell, Check, Send } from "@/components/icons";
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
import { Chip, ShareBar } from "@/app/_components/hostel-admin-page-ui";
import { RoleButton } from "@/app/_components/portal-dashboard-ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { NotificationsPageContent } from "./notifications-page";
import { Message, field, optionalField } from "./portal-shared";
import { PageHeader } from "./core-portal-shared";

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
    ? formatHostelDateTime(value)
    : "—";
}

export const HostelAdminNotificationsPageContent = memo(
  function HostelAdminNotificationsPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [audience, setAudience] = useState("ALL");
    const [selectedResidents, setSelectedResidents] = useState<string[]>([]);
    const [composing, setComposing] = useState(false);
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
          setComposing(false);
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
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          action={
            <RoleButton className="h-9 rounded-xl" onClick={() => setComposing(true)} tone="admin" type="button">
              <Send className="size-4" />
              Compose
            </RoleButton>
          }
          description="Send, schedule and track notices to residents."
          icon={Bell}
          title="Notifications"
        />
        {composing ? null : <Message value={actionMessage} />}

        <Dialog onOpenChange={setComposing} open={composing}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Compose</DialogTitle>
              <DialogDescription>Send now, or pick a time to schedule it.</DialogDescription>
            </DialogHeader>
            <Message value={actionMessage} />
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
              <div className="rounded-xl bg-muted/50 p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Recipients · {selectedResidents.length} picked
                </p>
                <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
                  {residents.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                      No active residents to pick from.
                    </p>
                  ) : (
                    residents.map((resident) => {
                      const on = selectedResidents.includes(resident.id);

                      return (
                        <button
                          aria-pressed={on}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition active:scale-95",
                            on
                              ? "border-transparent bg-role-team-soft text-role-team"
                              : "border-border bg-card text-muted-foreground hover:text-foreground",
                          )}
                          key={resident.id}
                          onClick={() =>
                            setSelectedResidents((current) =>
                              on ? current.filter((id) => id !== resident.id) : [...current, resident.id],
                            )
                          }
                          title={resident.roomType}
                          type="button"
                        >
                          {on ? <Check className="size-3.5" /> : null}
                          {resident.fullName ?? `${resident.firstName} ${resident.lastName}`.trim()}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}

            <DialogFooter>
              <button
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-teal px-4 text-[13.5px] font-semibold text-white transition hover:bg-brand-teal/90 disabled:opacity-60"
                disabled={busy}
                type="submit"
              >
                <Send aria-hidden="true" className="size-4" />
                {busy ? "Sending…" : "Send notification"}
              </button>
            </DialogFooter>
          </form>
          </DialogContent>
        </Dialog>

        <Panel title="Sent & scheduled">
          {campaignsResource.state === "loading" ? <LoadingRows /> : null}
          {campaignsResource.state === "error" ? (
            <EmptyState label="Campaigns could not be loaded." />
          ) : null}
          {campaignsResource.state !== "loading" && campaigns.length === 0 ? (
            <EmptyState label="Nothing sent yet. Compose your first one from the header." />
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            {campaigns.map((campaign) => (
              <div className="space-y-2.5 rounded-2xl border border-border/70 p-4" key={campaign.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-foreground">{campaign.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{campaign.body}</p>
                  </div>
                  <StatusBadge>{campaign.status}</StatusBadge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Chip glyph="pricetag">{campaign.category}</Chip>
                  <Chip glyph="people">{campaign.audience}</Chip>
                  <Chip glyph="flag" tone={campaign.priority === "URGENT" || campaign.priority === "HIGH" ? "warn" : "neutral"}>
                    {campaign.priority}
                  </Chip>
                  <Chip glyph="time">
                    {campaign.status === "SCHEDULED"
                      ? `Scheduled ${shortDateTime(campaign.scheduledFor)}`
                      : `Sent ${shortDateTime(campaign.sentAt)}`}
                  </Chip>
                </div>
                {/* Read counts come from the receipts themselves, so they stay
                    right even if a campaign is re-read months later. */}
                {campaign.stats.sent > 0 ? (
                  <ShareBar label={`read · ${campaign.stats.delivered} delivered`} total={campaign.stats.sent} value={campaign.stats.read} />
                ) : null}
              </div>
            ))}
          </div>
        </Panel>

        <NotificationsPageContent />
      </div>
    );
  },
);
